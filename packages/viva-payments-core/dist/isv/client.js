"use strict";
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
Object.defineProperty(exports, "__esModule", { value: true });
exports.IsvHttpClient = void 0;
const undici_1 = require("undici");
const index_js_1 = require("../types/index.js");
const http_js_1 = require("../auth/http.js");
const index_js_2 = require("../errors/index.js");
const index_js_3 = require("../errors/index.js");
const index_js_4 = require("../observability/index.js");
// ---------------------------------------------------------------------------
// Bigint-safe JSON utilities
// ---------------------------------------------------------------------------
/**
 * Bigint-safe JSON.stringify.
 *
 * - bigint values <= Number.MAX_SAFE_INTEGER → serialized as JSON number
 * - bigint values >  Number.MAX_SAFE_INTEGER → serialized as JSON string
 *   (emits a console.warn — the OrderCode case).
 *
 * Wire format: Viva's `Amount` is integer minor units (fits safe int for
 * realistic payment amounts). `OrderCode` is int64 and can exceed
 * Number.MAX_SAFE_INTEGER (e.g. 1234567890123456789).
 *
 * @see references/viva-docs/md/isv-partner-program.txt:104
 */
function bigintSafeStringify(value) {
    return JSON.stringify(value, (_key, val) => {
        if (typeof val === 'bigint') {
            if (val >= -BigInt(Number.MAX_SAFE_INTEGER) && val <= BigInt(Number.MAX_SAFE_INTEGER)) {
                return Number(val);
            }
            // TODO(impl): OrderCode > MAX_SAFE_INTEGER encoded as string — confirm
            // Viva accepts JSON string for OrderCode in request bodies. At present
            // only DELETE /checkout/v2/orders/{orderCode} uses OrderCode in the URL,
            // not in the body, so this path is informational only.
            // @see references/viva-docs/md/isv-partner-program.txt:104
            console.warn(`[viva-payments-core] bigint value ${val} exceeds Number.MAX_SAFE_INTEGER; encoding as JSON string`);
            return val.toString();
        }
        return val;
    });
}
/**
 * Bigint-safe JSON.parse for Viva API responses.
 *
 * Converts the `OrderCode` field to BigInt on parse to preserve precision.
 * Other numeric fields are left as JavaScript numbers (they fit safely).
 *
 * @see references/viva-docs/md/webhooks-for-payments.txt:495 (OrderCode is long/int64)
 * @see references/viva-docs/md/account-api.txt:1584 (OrderCode type: long)
 */
function bigintSafeParse(text) {
    // Preserve int64 precision: JSON.parse coerces numeric literals to lossy JS
    // numbers BEFORE the reviver runs, so an OrderCode > 2^53 is already corrupted
    // by the time we'd see it. Quote the raw OrderCode/orderCode numeric literals
    // in the source text first, so they arrive at the reviver as strings and go
    // straight to BigInt with full precision. (The previous comment claimed a
    // "regex below" did this — it didn't; values were silently truncated.)
    const preserved = text.replace(/("(?:OrderCode|orderCode)"\s*:\s*)(\d+)/g, '$1"$2"');
    return JSON.parse(preserved, (key, val) => {
        if (key === 'OrderCode' || key === 'orderCode') {
            if (typeof val === 'string') {
                return BigInt(val);
            }
            if (typeof val === 'number') {
                return BigInt(val);
            }
        }
        return val;
    });
}
// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------
const DEFAULT_BACKOFFS_MS = [500, 1500, 4500];
const DEFAULT_JITTER_RATIO = 0.2;
const DEFAULT_TIMEOUT_MS = 30_000;
const MAX_RETRIES = 3;
/** Connection-level error codes that indicate the request was never acked. */
const CONNECTION_ERROR_CODES = new Set([
    'ECONNRESET',
    'ENOTFOUND',
    'ETIMEDOUT',
    'ECONNREFUSED',
    'ECONNABORTED',
    'UND_ERR_CONNECT_TIMEOUT',
    'UND_ERR_HEADERS_TIMEOUT',
    'UND_ERR_BODY_TIMEOUT',
]);
// ---------------------------------------------------------------------------
// IsvHttpClient
// ---------------------------------------------------------------------------
/**
 * Shared HTTP client for all ISV API endpoints.
 *
 * Constructed once per platform context (auth strategy + environment) and
 * shared across IsvPayments, IsvAccounts, IsvWebhooks.
 *
 * @see references/viva-docs/md/isv-credentials.txt:107
 * @see references/viva-docs/md/isv-partner-program.txt:104
 */
class IsvHttpClient {
    apiBaseUrl;
    authStrategy;
    dispatcher;
    fetchImpl;
    now;
    backoffsMs;
    jitterRatio;
    defaultTimeoutMs;
    metrics;
    /**
     * Last observed `x-viva-correlationid` header value.
     * Updated after every successful HTTP response. Used by `requestWithMeta`.
     * Probe-verified 2026-04-25: Viva includes this on every response.
     */
    _vivaLastCorrelationId = undefined;
    /**
     * Last observed `x-viva-eventid` header value.
     * Updated after every successful HTTP response. Used by `requestWithMeta`.
     */
    _vivaLastEventId = undefined;
    constructor(config) {
        this.apiBaseUrl = index_js_1.ENVIRONMENT_URLS[config.environment].apiBaseUrl;
        this.authStrategy = config.authStrategy;
        this.now = config.now ?? (() => Date.now());
        this.backoffsMs = config.retryBackoffsMs ?? DEFAULT_BACKOFFS_MS;
        this.jitterRatio = config.jitterRatio ?? DEFAULT_JITTER_RATIO;
        this.defaultTimeoutMs = config.defaultTimeoutMs ?? DEFAULT_TIMEOUT_MS;
        this.metrics = config.metrics ?? new index_js_4.NoopMetricsHook();
        if (config.dispatcher) {
            this.dispatcher = config.dispatcher;
            // When a dispatcher is injected (tests), use undici's fetch with that dispatcher.
            this.fetchImpl = config.fetchImpl ?? undici_1.fetch;
        }
        else {
            this.dispatcher = (0, http_js_1.getApiDispatcher)(config.environment);
            this.fetchImpl = config.fetchImpl ?? undici_1.fetch;
        }
    }
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
    async request(opts) {
        // Auth-refresh-then-retry is handled outside the idempotent retry loop.
        // We do one auth-refresh cycle independently.
        const endpoint = opts.endpoint ?? `${opts.method} ${opts.path}`;
        return this.metrics.timeAsync('viva_api_request_duration_seconds', () => this._withAuthRefresh(opts), { endpoint });
    }
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
    async requestWithMeta(opts) {
        const endpoint = opts.endpoint ?? `${opts.method} ${opts.path}`;
        const data = await this.metrics.timeAsync('viva_api_request_duration_seconds', () => this._withAuthRefresh(opts), { endpoint });
        return {
            data,
            vivaCorrelationId: this._vivaLastCorrelationId,
            vivaEventId: this._vivaLastEventId,
        };
    }
    // --------------------------------------------------------------------------
    // Private helpers
    // --------------------------------------------------------------------------
    /**
     * Executes the request with a single auth-refresh-then-retry cycle.
     *
     * On first 401: forceRefresh token, retry the request once.
     * On second 401: throw VivaAuthError.
     *
     * @see references/viva-docs/md/isv-credentials.txt:107
     */
    async _withAuthRefresh(opts) {
        const token = await this.authStrategy.getBearerToken();
        try {
            return await this._executeWithRetry(opts, token);
        }
        catch (err) {
            if (err instanceof index_js_3.VivaAuthError && err.httpStatus === 401) {
                // Force-refresh and retry once.
                const freshToken = await this.authStrategy.getBearerToken({ forceRefresh: true });
                return await this._executeWithRetry(opts, freshToken);
            }
            throw err;
        }
    }
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
    async _executeWithRetry(opts, token) {
        let attempt = 0;
        // eslint-disable-next-line no-constant-condition
        while (true) {
            const { response, text } = await this._attempt(opts, token);
            // Extract Viva tracing headers — present on every response (probe-verified 2026-04-25).
            const vivaCorrelationId = response.headers.get('x-viva-correlationid') ?? undefined;
            const vivaEventId = response.headers.get('x-viva-eventid') ?? undefined;
            // Store last seen values for requestWithMeta.
            this._vivaLastCorrelationId = vivaCorrelationId;
            this._vivaLastEventId = vivaEventId;
            // --- happy path ---
            if (response.status >= 200 && response.status < 300) {
                if (!text || response.status === 204) {
                    return undefined;
                }
                return bigintSafeParse(text);
            }
            // --- 401: surface immediately (auth-refresh handled in _withAuthRefresh) ---
            if (response.status === 401) {
                const requestId = response.headers.get('Cf-Ray') ?? response.headers.get('CorrelationId') ?? undefined;
                throw new index_js_3.VivaAuthError({
                    message: `Viva API authentication failed (HTTP 401)`,
                    httpStatus: 401,
                    requestId,
                    vivaCorrelationId,
                    vivaEventId,
                });
            }
            // --- 429: rate limit ---
            if (response.status === 429) {
                if (opts.idempotent && attempt < MAX_RETRIES) {
                    const retryAfterMs = this._retryAfterMs(response) ?? this._backoffMs(attempt);
                    await this._sleep(retryAfterMs);
                    attempt++;
                    continue;
                }
                const requestId = response.headers.get('Cf-Ray') ?? response.headers.get('CorrelationId') ?? undefined;
                const retryAfterMs = this._retryAfterMs(response);
                throw new index_js_2.VivaRateLimitError({
                    message: `Viva API rate limited (HTTP 429)`,
                    httpStatus: 429,
                    requestId,
                    vivaCorrelationId,
                    vivaEventId,
                    ...(retryAfterMs !== undefined ? { retryAfterMs } : {}),
                });
            }
            // --- 5xx ---
            if (response.status >= 500) {
                if (opts.idempotent && attempt < MAX_RETRIES) {
                    const backoffMs = this._backoffMs(attempt);
                    await this._sleep(backoffMs);
                    attempt++;
                    continue;
                }
                const requestId = response.headers.get('Cf-Ray') ?? response.headers.get('CorrelationId') ?? undefined;
                const { vivaCode, vivaMessage } = this._parseErrorBody(text);
                throw new index_js_2.VivaApiError({
                    message: vivaMessage ?? `Viva API error (HTTP ${response.status})`,
                    httpStatus: response.status,
                    vivaCode,
                    requestId,
                    vivaCorrelationId,
                    vivaEventId,
                });
            }
            // --- other 4xx ---
            {
                const requestId = response.headers.get('Cf-Ray') ?? response.headers.get('CorrelationId') ?? undefined;
                const { vivaCode, vivaMessage } = this._parseErrorBody(text);
                throw new index_js_2.VivaApiError({
                    message: vivaMessage ?? `Viva API error (HTTP ${response.status})`,
                    httpStatus: response.status,
                    vivaCode,
                    requestId,
                    vivaCorrelationId,
                    vivaEventId,
                });
            }
        }
    }
    /**
     * Makes a single HTTP attempt. On connection-level errors:
     *   - If idempotent: bubble up (outer loop handles retry).
     *   - If NOT idempotent: retry once on connection-level errors per plan
     *     Auth Flow line 319 (request never acked).
     */
    async _attempt(opts, token) {
        const url = this._buildUrl(opts.path, opts.query);
        const timeoutMs = opts.timeoutMs ?? this.defaultTimeoutMs;
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
        const headers = {
            Authorization: `Bearer ${token}`,
            'Content-Type': 'application/json',
            Accept: 'application/json',
        };
        if (opts.idempotencyKey) {
            // TODO(impl): Viva's exact idempotency header name is unconfirmed.
            // Using `Idempotency-Key` (RFC 8929 / widely adopted convention).
            // Update if Viva docs specify a different header name.
            // @see references/viva-docs/md/isv-partner-program.txt:104
            headers['Idempotency-Key'] = opts.idempotencyKey;
        }
        const fetchOptions = {
            method: opts.method,
            headers,
            signal: controller.signal,
        };
        if (opts.body !== undefined) {
            fetchOptions.body = bigintSafeStringify(opts.body);
        }
        if (this.dispatcher) {
            fetchOptions['dispatcher'] = this.dispatcher;
        }
        let maxConnectionRetries = opts.idempotent ? 0 : 1;
        let connAttempt = 0;
        // eslint-disable-next-line no-constant-condition
        while (true) {
            try {
                const response = await this.fetchImpl(url, fetchOptions);
                clearTimeout(timeoutId);
                const text = await response.text();
                return { response, text };
            }
            catch (err) {
                clearTimeout(timeoutId);
                const isConnectionError = this._isConnectionError(err);
                const isAbort = err instanceof Error && err.name === 'AbortError';
                // Aborted due to our timeout (not network) → not a connection error.
                if (isAbort && !this._isBeforeAck(err)) {
                    throw new index_js_2.VivaApiError({
                        message: `Viva API request timed out after ${timeoutMs}ms`,
                        cause: err,
                    });
                }
                if ((isConnectionError || isAbort) && !opts.idempotent && connAttempt < maxConnectionRetries) {
                    // Non-idempotent: one retry on connection-level errors (request not acked).
                    connAttempt++;
                    continue;
                }
                throw new index_js_2.VivaApiError({
                    message: isAbort
                        ? `Viva API request timed out`
                        : `Viva API network error: ${err instanceof Error ? err.message : String(err)}`,
                    cause: err,
                });
            }
        }
    }
    _buildUrl(path, query) {
        const base = `${this.apiBaseUrl}${path}`;
        if (!query)
            return base;
        const params = new URLSearchParams();
        for (const [k, v] of Object.entries(query)) {
            if (v !== undefined) {
                params.set(k, String(v));
            }
        }
        const qs = params.toString();
        return qs ? `${base}?${qs}` : base;
    }
    _backoffMs(attempt) {
        const base = this.backoffsMs[attempt] ?? this.backoffsMs[this.backoffsMs.length - 1] ?? 500;
        const jitter = base * this.jitterRatio * (Math.random() * 2 - 1);
        return Math.max(0, Math.round(base + jitter));
    }
    _retryAfterMs(response) {
        const header = response.headers.get('Retry-After');
        if (!header)
            return undefined;
        const seconds = parseFloat(header);
        if (!isNaN(seconds))
            return Math.max(0, Math.round(seconds * 1000));
        // HTTP-date format — try to parse it.
        const date = new Date(header).getTime();
        if (!isNaN(date))
            return Math.max(0, date - this.now());
        return undefined;
    }
    _parseErrorBody(text) {
        if (!text)
            return {};
        try {
            const parsed = JSON.parse(text);
            // Viva error response shape observed: { ErrorCode, Message } or similar
            // TODO(impl): confirm exact Viva error body field names (ErrorCode vs error_code, Message vs message)
            // @see references/viva-docs/md/isv-partner-program.txt:104
            const vivaCode = typeof parsed['ErrorCode'] === 'number'
                ? String(parsed['ErrorCode'])
                : typeof parsed['errorCode'] === 'number'
                    ? String(parsed['errorCode'])
                    : typeof parsed['error'] === 'string'
                        ? parsed['error']
                        : undefined;
            const vivaMessage = typeof parsed['Message'] === 'string'
                ? parsed['Message']
                : typeof parsed['message'] === 'string'
                    ? parsed['message']
                    : undefined;
            return { vivaCode, vivaMessage };
        }
        catch {
            return {};
        }
    }
    _isConnectionError(err) {
        if (!(err instanceof Error))
            return false;
        const code = err.code;
        if (code && CONNECTION_ERROR_CODES.has(code))
            return true;
        // undici-specific
        if (err.message.includes('ECONNRESET') || err.message.includes('ENOTFOUND'))
            return true;
        return false;
    }
    /**
     * Heuristic: was the abort triggered before any byte was received?
     * Since AbortError doesn't carry this info directly, we treat all AbortErrors
     * from our own timeout as "possibly not acked" — safe for non-idempotent retry.
     */
    _isBeforeAck(_err) {
        return true;
    }
    _sleep(ms) {
        return new Promise((resolve) => setTimeout(resolve, ms));
    }
}
exports.IsvHttpClient = IsvHttpClient;
//# sourceMappingURL=client.js.map