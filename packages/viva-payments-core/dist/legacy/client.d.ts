/**
 * BasicAuthClient — HTTP client for Viva legacy API endpoints (Basic auth).
 *
 * Viva exposes a subset of endpoints ONLY on their legacy host
 * (`demo.vivapayments.com` / `www.vivapayments.com`) behind Basic auth
 * (MerchantId:ApiKey). These endpoints are NOT available on the v2/OAuth2
 * surface (`demo-api.vivapayments.com`).
 *
 * Verified against Viva sandbox 2026-04-25:
 * - Refund: `POST /api/transactions/{transactionId}` on legacy host with Basic auth.
 *   - Body: `application/x-www-form-urlencoded` — `Amount={minor}&SourceCode={code}`.
 *   - Response: PascalCase JSON `{StatusId, Amount, TransactionId, ...}`.
 *   - `POST /checkout/v2/transactions/{id}` (v2) returns 405 → NOT valid.
 *
 * Design:
 *   - NOT a fallback. This is the PRIMARY (and only) client for legacy endpoints.
 *   - Same retry / error-shape conventions as IsvHttpClient.
 *   - Form-encoded body builder via URLSearchParams (built-in, zero deps).
 *   - Tracing headers (`x-viva-correlationid`, `x-viva-eventid`) extracted and
 *     attached to errors and successful responses.
 *
 * @see references/viva-docs/md/tut-create-recurring-payment.txt:288
 * @see references/viva-docs/md/merchant-id-and-api-key.txt:1
 */
import type { Dispatcher } from 'undici';
import type { VivaEnvironment } from '../types/index.js';
import type { MetricsHook } from '../observability/index.js';
/**
 * Which Basic-auth flavour to use when calling Viva's legacy host.
 *
 * - `merchant`: standard MerchantId/ApiKey Basic auth — used by single-merchant
 *   integrations (the original `BasicAuthClient` flavour).
 * - `reseller`: ISV/reseller Basic auth scoped to one connected merchant —
 *   username is `ResellerId:MerchantId`, password is `ResellerApiKey`. Used by
 *   ISV admin operations such as `POST /api/sources`.
 *
 * @see docs/AUTH.md §1.2
 */
export type BasicAuthVariant = 'merchant' | 'reseller';
/** Fields shared by both Basic-auth variants. */
interface BasicAuthClientCommonConfig {
    /**
     * Viva environment selector. Determines legacy host.
     *   demo       → https://demo.vivapayments.com
     *   production → https://www.vivapayments.com
     */
    environment: VivaEnvironment;
    /** Override undici dispatcher for tests (e.g. MockAgent). */
    dispatcher?: Dispatcher;
    /** Override global fetch. Defaults to undici fetch when dispatcher is provided. */
    fetchImpl?: typeof fetch;
    /** Clock override for tests. Defaults to Date.now. */
    now?: () => number;
    /**
     * Exponential backoff schedule in milliseconds.
     * Default: [500, 1500, 4500].
     */
    retryBackoffsMs?: number[];
    /** Jitter ratio applied to each backoff (±ratio * backoff). Default: 0.2. */
    jitterRatio?: number;
    /** Default per-request timeout in milliseconds. Default: 30_000. */
    defaultTimeoutMs?: number;
    /** Optional metrics hook. */
    metrics?: MetricsHook;
}
/**
 * Merchant-flavoured Basic auth: `Basic base64(merchantId:apiKey)`.
 *
 * `authVariant` is optional and defaults to `'merchant'` so pre-existing call
 * sites that did not set the discriminator continue to compile.
 *
 * @see docs/AUTH.md §1.2 (Merchant Basic)
 * @see references/viva-docs/md/merchant-id-and-api-key.txt:1
 */
export interface MerchantBasicAuthClientConfig extends BasicAuthClientCommonConfig {
    authVariant?: 'merchant';
    /**
     * Merchant ID (UUID). Used as the Basic-auth username.
     * @see references/viva-docs/md/merchant-id-and-api-key.txt:1
     */
    merchantId: string;
    /**
     * API Key. Used as the Basic-auth password.
     * @see references/viva-docs/md/merchant-id-and-api-key.txt:1
     */
    apiKey: string;
}
/**
 * Reseller-flavoured Basic auth: `Basic base64(resellerId:merchantId:resellerApiKey)`.
 *
 * The reseller credentials are scoped to **one** connected merchant per
 * instance — to operate on multiple merchants under the same reseller account,
 * construct multiple `BasicAuthClient` instances.
 *
 * @see docs/AUTH.md §1.2 (Reseller Basic)
 */
export interface ResellerBasicAuthClientConfig extends BasicAuthClientCommonConfig {
    authVariant: 'reseller';
    /** Reseller ID (UUID) — the ISV's reseller account. */
    resellerId: string;
    /** Connected merchant ID (UUID) — the merchant the reseller is operating on. */
    merchantId: string;
    /** Reseller API key. */
    resellerApiKey: string;
}
export type BasicAuthClientConfig = MerchantBasicAuthClientConfig | ResellerBasicAuthClientConfig;
export interface LegacyRequestOptions {
    method: 'GET' | 'POST' | 'DELETE';
    path: string;
    /**
     * Query-string key-value pairs appended to `path`. Values are coerced to
     * string; `undefined` values are skipped. Used by the Standard refund
     * (`DELETE /api/transactions/{id}?amount=&sourceCode=&currencyCode=`) — Viva's
     * Cancel transaction endpoint takes its parameters in the query string, not a
     * body.
     * @see docs/internal/payment-api.yaml:8592 (merchant Cancel transaction)
     * @see docs/internal/payment-isv-api.yaml:2640 (ISV Cancel transaction)
     */
    query?: Record<string, string | number | bigint | undefined>;
    /** Form-encoded key-value pairs (values coerced to string). */
    formBody?: Record<string, string | number | bigint | undefined>;
    /**
     * JSON body (sent as `application/json`). Mutually exclusive with `formBody`.
     * Used by endpoints such as `POST /api/sources` that expect JSON rather than
     * the legacy `application/x-www-form-urlencoded` shape.
     */
    jsonBody?: Record<string, unknown>;
    /**
     * When true: retries on 429 and 5xx per the backoff schedule.
     * When false: only retries on connection-level errors.
     */
    idempotent: boolean;
    timeoutMs?: number;
    /** Endpoint label for metrics. */
    endpoint?: string;
}
/**
 * Wrapper returned from successful legacy API calls.
 * Includes Viva tracing headers for observability.
 */
export interface LegacyApiResult<T> {
    data: T;
    /** `x-viva-correlationid` header value (e.g. "26-115-EDAA55BC"). */
    vivaCorrelationId: string | undefined;
    /** `x-viva-eventid` header value (e.g. "0"). */
    vivaEventId: string | undefined;
}
/**
 * HTTP client for Viva legacy API endpoints (Basic auth + legacy host).
 *
 * Instantiate once per (merchantId + apiKey + environment) tuple.
 * Thread-safe; no shared mutable state.
 */
export declare class BasicAuthClient {
    private readonly legacyBaseUrl;
    private readonly authorizationHeader;
    private readonly authVariant;
    private readonly dispatcher;
    private readonly fetchImpl;
    private readonly now;
    private readonly backoffsMs;
    private readonly jitterRatio;
    private readonly defaultTimeoutMs;
    private readonly metrics;
    constructor(config: BasicAuthClientConfig);
    /**
     * Execute a request against the Viva legacy API.
     *
     * Returns a `LegacyApiResult<T>` wrapping both the parsed response and the
     * Viva tracing headers (`x-viva-correlationid`, `x-viva-eventid`).
     *
     * @see references/viva-docs/md/tut-create-recurring-payment.txt:288
     */
    request<T>(opts: LegacyRequestOptions): Promise<LegacyApiResult<T>>;
    /**
     * Fetch the webhook verification key from the merchant-mode Viva legacy API.
     *
     * Calls `GET /api/messages/config/token` with Merchant Basic auth and returns
     * the verification key string that the operator must paste into Viva Self
     * Care → Sales → API Access → Webhooks. Used by the
     * `viva-register-webhooks --apply` CLI in merchant mode.
     *
     * Response shape is tolerated in both casings — the Viva docs show `"Key"`
     * but field-name canonicality has not been probe-verified yet, so both
     * `{ Key }` and `{ key }` are accepted.
     *
     * @see docs/ENDPOINTS.md §8.1
     * @see references/viva-docs/md/webhooks-for-payments.txt:311
     */
    fetchWebhookVerificationKey(): Promise<string>;
    /**
     * Build the `Authorization: Basic <base64>` header per variant.
     *
     * - merchant: `base64(merchantId:apiKey)`
     * - reseller: `base64(resellerId:merchantId:resellerApiKey)`
     *
     * @see docs/AUTH.md §1.2
     */
    private static buildAuthorizationHeader;
    private _executeWithRetry;
    private _attempt;
    private _backoffMs;
    private _retryAfterMs;
    private _parseErrorBody;
    private _isConnectionError;
    private _sleep;
}
export {};
//# sourceMappingURL=client.d.ts.map