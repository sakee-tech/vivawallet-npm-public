/**
 * LegacyBasicClient — HTTP client for Viva legacy API endpoints (Basic auth).
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
export interface LegacyBasicClientConfig {
    /**
     * Viva environment selector. Determines legacy host.
     *   demo       → https://demo.vivapayments.com
     *   production → https://www.vivapayments.com
     */
    environment: VivaEnvironment;
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
export interface LegacyRequestOptions {
    method: 'GET' | 'POST';
    path: string;
    /** Form-encoded key-value pairs (values coerced to string). */
    formBody?: Record<string, string | number | bigint | undefined>;
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
export declare class LegacyBasicClient {
    private readonly legacyBaseUrl;
    private readonly authorizationHeader;
    private readonly dispatcher;
    private readonly fetchImpl;
    private readonly now;
    private readonly backoffsMs;
    private readonly jitterRatio;
    private readonly defaultTimeoutMs;
    private readonly metrics;
    constructor(config: LegacyBasicClientConfig);
    /**
     * Execute a request against the Viva legacy API.
     *
     * Returns a `LegacyApiResult<T>` wrapping both the parsed response and the
     * Viva tracing headers (`x-viva-correlationid`, `x-viva-eventid`).
     *
     * @see references/viva-docs/md/tut-create-recurring-payment.txt:288
     */
    request<T>(opts: LegacyRequestOptions): Promise<LegacyApiResult<T>>;
    private _executeWithRetry;
    private _attempt;
    private _backoffMs;
    private _retryAfterMs;
    private _parseErrorBody;
    private _isConnectionError;
    private _sleep;
}
//# sourceMappingURL=legacy-basic-client.d.ts.map