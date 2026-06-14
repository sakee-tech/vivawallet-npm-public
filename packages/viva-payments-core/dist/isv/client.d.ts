/**
 * IsvHttpClient — shared HTTP wrapper for all ISV API calls.
 *
 * Responsibilities:
 *   - Resolve base URL from VivaEnvironment
 *   - Inject Authorization header from AuthStrategy.getBearerToken()
 *   - Bigint-safe JSON serialization (request body) and deserialization (response)
 *   - Per-request timeout via AbortController
 *   - Retry policy: idempotent requests retry 429 + 5xx up to 3 times with
 *     exponential backoff [500, 1500, 4500]ms ±20% jitter
 *   - Non-idempotent POST: only retry on connection-level errors (never on ack)
 *   - 401 handling: force-refresh token once, retry same request once
 *   - Error mapping to typed VivaError subclasses
 *
 * @see references/viva-docs/md/isv-credentials.txt:107 (auth credential types)
 * @see references/viva-docs/md/isv-partner-program.txt:104 (ISV API overview)
 */
import type { Dispatcher } from 'undici';
import type { AuthStrategy, VivaEnvironment } from '../types/index.js';
import type { MetricsHook } from '../observability/index.js';
export interface IsvHttpClientConfig {
    environment: VivaEnvironment;
    authStrategy: AuthStrategy;
    /** Override undici dispatcher for tests (e.g. MockAgent). */
    dispatcher?: Dispatcher;
    /** Override global fetch. Defaults to undici fetch when dispatcher is provided, else global fetch. */
    fetchImpl?: typeof fetch;
    /** Clock override for tests. Defaults to Date.now. */
    now?: () => number;
    /**
     * Exponential backoff schedule in milliseconds.
     * Default: [500, 1500, 4500] per plan Auth Flow line 319.
     *
     * @see references/viva-docs/md/isv-partner-program.txt:104
     */
    retryBackoffsMs?: number[];
    /**
     * Jitter ratio applied to each backoff (±jitterRatio * backoff).
     * Default: 0.2 (±20%).
     *
     * @see references/viva-docs/md/isv-partner-program.txt:104
     */
    jitterRatio?: number;
    /** Default per-request timeout in milliseconds. Default: 30_000. */
    defaultTimeoutMs?: number;
    /** Optional metrics hook. Records viva_api_request_duration_seconds. */
    metrics?: MetricsHook;
}
interface RequestOptions {
    method: 'GET' | 'POST' | 'PATCH' | 'DELETE';
    path: string;
    query?: Record<string, string | number | bigint | undefined>;
    body?: unknown;
    /**
     * Sets the `Idempotency-Key` header on the request.
     *
     * TODO(impl): Viva's exact idempotency header name is unconfirmed from local docs.
     * Using `Idempotency-Key` (standard RFC 8929 / common vendor practice).
     * If Viva uses a different name, update this constant.
     * @see references/viva-docs/md/isv-partner-program.txt:104
     */
    idempotencyKey?: string;
    timeoutMs?: number;
    /**
     * When true: retries on 429 and 5xx per the backoff schedule.
     * When false: only retries on connection-level errors (never on ack).
     *
     * @see references/viva-docs/md/isv-partner-program.txt:104 (Auth Flow line 319)
     */
    idempotent: boolean;
    /**
     * Endpoint label for metrics: `${METHOD} ${pathTemplate}` (no query string).
     * Example: `'POST /checkout/v2/orders'`
     * Callers must supply the template (not the concrete URL with query params).
     */
    endpoint?: string;
}
/**
 * Shared HTTP client for all ISV API endpoints.
 *
 * Constructed once per platform context (auth strategy + environment) and
 * shared across IsvPayments, IsvAccounts, IsvWebhooks.
 *
 * @see references/viva-docs/md/isv-credentials.txt:107
 * @see references/viva-docs/md/isv-partner-program.txt:104
 */
export declare class IsvHttpClient {
    private readonly apiBaseUrl;
    private readonly authStrategy;
    private readonly dispatcher;
    private readonly fetchImpl;
    private readonly now;
    private readonly backoffsMs;
    private readonly jitterRatio;
    private readonly defaultTimeoutMs;
    private readonly metrics;
    /**
     * Last observed `x-viva-correlationid` header value.
     * Updated after every successful HTTP response. Used by `requestWithMeta`.
     * Probe-verified 2026-04-25: Viva includes this on every response.
     */
    private _vivaLastCorrelationId;
    /**
     * Last observed `x-viva-eventid` header value.
     * Updated after every successful HTTP response. Used by `requestWithMeta`.
     */
    private _vivaLastEventId;
    constructor(config: IsvHttpClientConfig);
    /**
     * Execute an outbound request to the Viva ISV API.
     *
     * Auth flow per plan Auth Flow line 317:
     *   1. Get bearer token from authStrategy.
     *   2. Execute request.
     *   3. On 401: force-refresh token once, retry once.
     *   4. Second 401 → VivaAuthError.
     *
     * Retry policy per plan Auth Flow line 319:
     *   - Idempotent: retry 429 + 5xx up to MAX_RETRIES with backoff + jitter.
     *   - Non-idempotent: retry only on connection-level errors.
     *
     * @see references/viva-docs/md/isv-credentials.txt:107 (auth strategy)
     * @see references/viva-docs/md/isv-partner-program.txt:104 (retry policy)
     */
    request<T>(opts: RequestOptions): Promise<T>;
    /**
     * Like `request<T>` but also returns Viva tracing headers.
     *
     * Returns `{ data: T, vivaCorrelationId, vivaEventId }` for observability.
     * Use this when the caller needs the `x-viva-correlationid` / `x-viva-eventid`
     * values (e.g. to log them or attach them to structured traces).
     *
     * Probe-verified 2026-04-25: both headers are present on every Viva response.
     *
     * @see references/viva-docs/md/isv-partner-program.txt:104
     */
    requestWithMeta<T>(opts: RequestOptions): Promise<{
        data: T;
        vivaCorrelationId: string | undefined;
        vivaEventId: string | undefined;
    }>;
    /**
     * Executes the request with a single auth-refresh-then-retry cycle.
     *
     * On first 401: forceRefresh token, retry the request once.
     * On second 401: throw VivaAuthError.
     *
     * @see references/viva-docs/md/isv-credentials.txt:107
     */
    private _withAuthRefresh;
    /**
     * Executes the request with the idempotent retry loop.
     * Does NOT handle auth-refresh — that is the caller's responsibility.
     *
     * Viva tracing headers are extracted on every response:
     *   - `x-viva-correlationid` (e.g. "26-115-EDAA55BC") — probe-verified 2026-04-25.
     *   - `x-viva-eventid` (e.g. "0") — probe-verified 2026-04-25.
     * On errors these are attached to the thrown VivaError. On success they are
     * available via the `_vivaLastCorrelationId` / `_vivaLastEventId` fields for
     * callers that need them (use `request<T>` for the raw value; use
     * `requestWithMeta<T>` for explicit access to the tracing pair).
     *
     * @see references/viva-docs/md/isv-partner-program.txt:104 (Auth Flow line 319)
     */
    private _executeWithRetry;
    /**
     * Makes a single HTTP attempt. On connection-level errors:
     *   - If idempotent: bubble up (outer loop handles retry).
     *   - If NOT idempotent: retry once on connection-level errors per plan
     *     Auth Flow line 319 (request never acked).
     */
    private _attempt;
    private _buildUrl;
    private _backoffMs;
    private _retryAfterMs;
    private _parseErrorBody;
    private _isConnectionError;
    /**
     * Heuristic: was the abort triggered before any byte was received?
     * Since AbortError doesn't carry this info directly, we treat all AbortErrors
     * from our own timeout as "possibly not acked" — safe for non-idempotent retry.
     */
    private _isBeforeAck;
    private _sleep;
}
export {};
//# sourceMappingURL=client.d.ts.map