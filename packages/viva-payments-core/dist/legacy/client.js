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
import { fetch as undiciFetch } from 'undici';
import { LEGACY_HOST } from '../types/index.js';
import { VivaApiError, VivaAuthError, VivaRateLimitError } from '../errors/index.js';
import { NoopMetricsHook } from '../observability/index.js';
// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------
const DEFAULT_BACKOFFS_MS = [500, 1500, 4500];
const DEFAULT_JITTER_RATIO = 0.2;
const DEFAULT_TIMEOUT_MS = 30_000;
const MAX_RETRIES = 3;
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
// BasicAuthClient
// ---------------------------------------------------------------------------
/**
 * HTTP client for Viva legacy API endpoints (Basic auth + legacy host).
 *
 * Instantiate once per (merchantId + apiKey + environment) tuple.
 * Thread-safe; no shared mutable state.
 */
export class BasicAuthClient {
    legacyBaseUrl;
    authorizationHeader;
    authVariant;
    dispatcher;
    fetchImpl;
    now;
    backoffsMs;
    jitterRatio;
    defaultTimeoutMs;
    metrics;
    constructor(config) {
        this.legacyBaseUrl = LEGACY_HOST[config.environment];
        this.authVariant = config.authVariant ?? 'merchant';
        this.authorizationHeader = BasicAuthClient.buildAuthorizationHeader(config);
        this.now = config.now ?? (() => Date.now());
        this.backoffsMs = config.retryBackoffsMs ?? DEFAULT_BACKOFFS_MS;
        this.jitterRatio = config.jitterRatio ?? DEFAULT_JITTER_RATIO;
        this.defaultTimeoutMs = config.defaultTimeoutMs ?? DEFAULT_TIMEOUT_MS;
        this.metrics = config.metrics ?? new NoopMetricsHook();
        if (config.dispatcher) {
            this.dispatcher = config.dispatcher;
            this.fetchImpl = config.fetchImpl ?? undiciFetch;
        }
        else {
            this.dispatcher = undefined;
            this.fetchImpl = config.fetchImpl ?? undiciFetch;
        }
    }
    /**
     * Execute a request against the Viva legacy API.
     *
     * Returns a `LegacyApiResult<T>` wrapping both the parsed response and the
     * Viva tracing headers (`x-viva-correlationid`, `x-viva-eventid`).
     *
     * @see references/viva-docs/md/tut-create-recurring-payment.txt:288
     */
    async request(opts) {
        const endpoint = opts.endpoint ?? `${opts.method} ${opts.path}`;
        return this.metrics.timeAsync('viva_legacy_api_request_duration_seconds', () => this._executeWithRetry(opts), { endpoint });
    }
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
    async fetchWebhookVerificationKey() {
        const result = await this.request({
            method: 'GET',
            path: '/api/messages/config/token',
            idempotent: true,
            endpoint: 'GET /api/messages/config/token',
        });
        const body = result.data ?? {};
        const rawKey = typeof body['Key'] === 'string'
            ? body['Key']
            : typeof body['key'] === 'string'
                ? body['key']
                : undefined;
        if (!rawKey || rawKey.length === 0) {
            throw new VivaApiError({
                message: 'Viva legacy API returned no verification key from GET /api/messages/config/token ' +
                    '(expected `Key` or `key` field on the response body)',
                requestId: result.vivaCorrelationId,
            });
        }
        return rawKey;
    }
    // --------------------------------------------------------------------------
    // Private helpers
    // --------------------------------------------------------------------------
    /**
     * Build the `Authorization: Basic <base64>` header per variant.
     *
     * - merchant: `base64(merchantId:apiKey)`
     * - reseller: `base64(resellerId:merchantId:resellerApiKey)`
     *
     * @see docs/AUTH.md §1.2
     */
    static buildAuthorizationHeader(config) {
        if (config.authVariant === 'reseller') {
            const { resellerId, merchantId, resellerApiKey } = config;
            if (!resellerId || !merchantId || !resellerApiKey) {
                throw new TypeError('BasicAuthClient: reseller variant requires non-empty resellerId, merchantId, and resellerApiKey');
            }
            const encoded = Buffer.from(`${resellerId}:${merchantId}:${resellerApiKey}`).toString('base64');
            return `Basic ${encoded}`;
        }
        // merchant (default — authVariant either 'merchant' or undefined)
        const { merchantId, apiKey } = config;
        if (!merchantId || !apiKey) {
            throw new TypeError('BasicAuthClient: merchant variant requires non-empty merchantId and apiKey');
        }
        const encoded = Buffer.from(`${merchantId}:${apiKey}`).toString('base64');
        return `Basic ${encoded}`;
    }
    async _executeWithRetry(opts) {
        let attempt = 0;
        // eslint-disable-next-line no-constant-condition
        while (true) {
            const { response, text } = await this._attempt(opts);
            const vivaCorrelationId = response.headers.get('x-viva-correlationid') ?? undefined;
            const vivaEventId = response.headers.get('x-viva-eventid') ?? undefined;
            // --- happy path ---
            if (response.status >= 200 && response.status < 300) {
                if (!text || response.status === 204) {
                    return { data: undefined, vivaCorrelationId, vivaEventId };
                }
                const data = JSON.parse(text);
                return { data, vivaCorrelationId, vivaEventId };
            }
            // --- 401 ---
            if (response.status === 401) {
                const hint = this.authVariant === 'reseller'
                    ? 'check resellerId, merchantId, and resellerApiKey'
                    : 'check merchantId and apiKey';
                throw new VivaAuthError({
                    message: `Viva legacy API authentication failed (HTTP 401) — ${hint}`,
                    httpStatus: 401,
                    requestId: vivaCorrelationId,
                });
            }
            // --- 429 ---
            if (response.status === 429) {
                if (opts.idempotent && attempt < MAX_RETRIES) {
                    const retryAfterMs = this._retryAfterMs(response) ?? this._backoffMs(attempt);
                    await this._sleep(retryAfterMs);
                    attempt++;
                    continue;
                }
                const retryAfterMs = this._retryAfterMs(response);
                throw new VivaRateLimitError({
                    message: 'Viva legacy API rate limited (HTTP 429)',
                    httpStatus: 429,
                    requestId: vivaCorrelationId,
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
                const { vivaCode, vivaMessage } = this._parseErrorBody(text);
                throw new VivaApiError({
                    message: vivaMessage ?? `Viva legacy API error (HTTP ${response.status})`,
                    httpStatus: response.status,
                    vivaCode,
                    requestId: vivaCorrelationId,
                });
            }
            // --- other 4xx ---
            {
                const { vivaCode, vivaMessage } = this._parseErrorBody(text);
                throw new VivaApiError({
                    message: vivaMessage ?? `Viva legacy API error (HTTP ${response.status})`,
                    httpStatus: response.status,
                    vivaCode,
                    requestId: vivaCorrelationId,
                });
            }
        }
    }
    async _attempt(opts) {
        const url = `${this.legacyBaseUrl}${opts.path}`;
        const timeoutMs = opts.timeoutMs ?? this.defaultTimeoutMs;
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
        const headers = {
            Authorization: this.authorizationHeader,
            Accept: 'application/json',
        };
        const fetchOptions = {
            method: opts.method,
            headers,
            signal: controller.signal,
        };
        // Body encoding — JSON for endpoints that take `application/json`
        // (e.g. POST /api/sources under reseller Basic auth), form-urlencoded for
        // legacy endpoints (refunds). Mutually exclusive — JSON wins if both set.
        if (opts.jsonBody !== undefined) {
            fetchOptions.body = JSON.stringify(opts.jsonBody);
            headers['Content-Type'] = 'application/json';
        }
        else if (opts.formBody && Object.keys(opts.formBody).length > 0) {
            const params = new URLSearchParams();
            for (const [k, v] of Object.entries(opts.formBody)) {
                if (v !== undefined) {
                    params.set(k, String(v));
                }
            }
            fetchOptions.body = params.toString();
            headers['Content-Type'] = 'application/x-www-form-urlencoded';
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
                if ((isConnectionError || isAbort) && !opts.idempotent && connAttempt < maxConnectionRetries) {
                    connAttempt++;
                    continue;
                }
                throw new VivaApiError({
                    message: isAbort
                        ? `Viva legacy API request timed out after ${timeoutMs}ms`
                        : `Viva legacy API network error: ${err instanceof Error ? err.message : String(err)}`,
                    cause: err,
                });
            }
        }
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
            const result = {};
            if (vivaCode !== undefined)
                result.vivaCode = vivaCode;
            if (vivaMessage !== undefined)
                result.vivaMessage = vivaMessage;
            return result;
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
        if (err.message.includes('ECONNRESET') || err.message.includes('ENOTFOUND'))
            return true;
        return false;
    }
    _sleep(ms) {
        return new Promise((resolve) => setTimeout(resolve, ms));
    }
}
//# sourceMappingURL=client.js.map