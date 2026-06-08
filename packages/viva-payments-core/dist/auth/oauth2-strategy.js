"use strict";
/**
 * OAuth 2.0 client_credentials strategy for Viva Wallet ISV API calls.
 *
 * Handles the full token lifecycle: obtain, cache, refresh, and single-flight
 * de-duplication to prevent stampede under concurrent load.
 *
 * @see references/viva-docs/md/oauth2-authentication.txt:128 (token endpoint)
 * @see references/viva-docs/md/oauth2-authentication.txt:145 (demo/prod URLs)
 * @see references/viva-docs/md/oauth2-authentication.txt:167 (grant_type, Basic auth header)
 * @see references/viva-docs/md/oauth2-authentication.txt:179 (token response shape, expires_in)
 * @see references/viva-docs/md/oauth2-authentication.txt:192 (3600s expiry)
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.OAuth2ClientCredentialsStrategy = void 0;
const common_js_1 = require("../types/common.js");
const auth_error_js_1 = require("../errors/auth-error.js");
const api_error_js_1 = require("../errors/api-error.js");
const rate_limit_error_js_1 = require("../errors/rate-limit-error.js");
const single_flight_js_1 = require("./single-flight.js");
const token_cache_js_1 = require("./token-cache.js");
const http_js_1 = require("./http.js");
const index_js_1 = require("../observability/index.js");
// ---------------------------------------------------------------------------
// Strategy implementation
// ---------------------------------------------------------------------------
/**
 * OAuth 2.0 `client_credentials` token strategy.
 *
 * Flow:
 * 1. Check cache. If token is fresh (expires_at > now + refreshSkewMs), return it.
 * 2. Acquire single-flight lock. Re-check cache (avoid duplicate fetch after waking).
 * 3. POST `grant_type=client_credentials` to the token endpoint.
 * 4. Cache result with `expires_at = now + (expires_in * 1000) - 60_000`.
 *
 * A1 property: `forceRefresh=true` (used by S3 on 401-recovery) ALSO acquires
 * the single-flight lock, so even during concurrent secret rotation only one
 * worker calls `/connect/token`. This is naturally satisfied because
 * `getBearerToken` unconditionally enters `singleFlight` when the cache check
 * is bypassed or fails.
 */
class OAuth2ClientCredentialsStrategy {
    name = 'oauth2-client-credentials';
    _env;
    _clientId;
    _clientSecret;
    _cache;
    _mutex;
    _redisLock;
    _refreshSkewMs;
    _fetchImpl;
    _dispatcher;
    _now;
    _metrics;
    _logger;
    constructor(opts) {
        this._env = opts.environment;
        this._clientId = opts.clientId;
        this._clientSecret = opts.clientSecret;
        this._cache = opts.cache ?? new token_cache_js_1.InMemoryTokenCache();
        this._mutex = opts.mutex ?? new single_flight_js_1.AsyncMutex();
        this._redisLock = opts.redisLock;
        this._refreshSkewMs = opts.refreshSkewMs ?? 5 * 60_000;
        this._fetchImpl = opts.fetchImpl ?? globalThis.fetch;
        this._dispatcher = opts.dispatcher;
        this._now = opts.now ?? (() => Date.now());
        this._metrics = opts.metrics ?? new index_js_1.NoopMetricsHook();
        this._logger = opts.logger;
    }
    /** Exposes the token cache for auth-status inspection. */
    get tokenCache() {
        return this._cache;
    }
    /** Cache key format: `viva:isv:token:{clientId}:{environment}` */
    get _cacheKey() {
        return `viva:isv:token:${this._clientId}:${this._env}`;
    }
    /**
     * Returns a valid bearer token for use in `Authorization: Bearer <token>`.
     *
     * When `forceRefresh` is true the cache lookup is skipped but the request
     * STILL goes through the single-flight lock — this is the A1 property:
     * multiple workers calling `getBearerToken({ forceRefresh: true })` after
     * receiving a 401 will not stampede the token endpoint.
     * // A1: forceRefresh bypasses cache but not the lock — stampede prevention
     * //     holds even during secret rotation. All concurrent 401-recovery calls
     * //     will coalesce into one token fetch. (Plan amendment A1.)
     */
    async getBearerToken(opts) {
        const forceRefresh = opts?.forceRefresh === true;
        // Step 1: fast-path cache hit (skipped on forceRefresh).
        if (!forceRefresh) {
            const cached = await this._cache.get(this._cacheKey);
            if (cached && cached.expires_at > this._now() + this._refreshSkewMs) {
                return cached.access_token;
            }
        }
        // Step 2–4: go through single-flight lock regardless of forceRefresh.
        // A1: forceRefresh bypasses cache but not the lock — stampede prevention
        //     holds even during secret rotation. All concurrent 401-recovery calls
        //     coalesce into a single /connect/token fetch. (Plan amendment A1.)
        const locks = this._redisLock
            ? { redis: this._redisLock }
            : { local: this._mutex };
        return (0, single_flight_js_1.singleFlight)(this._cacheKey, async () => {
            // Re-check cache after acquiring the lock; another waiter may have
            // already refreshed the token while we were queued.
            if (!forceRefresh) {
                const reChecked = await this._cache.get(this._cacheKey);
                if (reChecked && reChecked.expires_at > this._now() + this._refreshSkewMs) {
                    return reChecked.access_token;
                }
            }
            return this._fetchToken();
        }, locks);
    }
    /**
     * Fetches a fresh token from the Viva identity server.
     *
     * Endpoint:
     *   Demo:       https://demo-accounts.vivapayments.com/connect/token
     *   Production: https://accounts.vivapayments.com/connect/token
     *
     * @see references/viva-docs/md/oauth2-authentication.txt:145 (endpoint URLs)
     * @see references/viva-docs/md/oauth2-authentication.txt:167 (curl example: grant_type, Basic header)
     * @see references/viva-docs/md/oauth2-authentication.txt:179 (response: access_token, expires_in)
     * @see references/viva-docs/md/oauth2-authentication.txt:192 (3600s token lifetime)
     */
    async _fetchToken() {
        return this._metrics.timeAsync('viva_auth_token_refresh_duration_seconds', () => this._doFetchToken());
    }
    async _doFetchToken() {
        const { authBaseUrl } = common_js_1.ENVIRONMENT_URLS[this._env];
        const url = `${authBaseUrl}/connect/token`;
        // Base64-encode Client_ID:Client_Secret per Viva OAuth2 docs line 153.
        // @see references/viva-docs/md/oauth2-authentication.txt:153
        const credentials = Buffer.from(`${this._clientId}:${this._clientSecret}`).toString('base64');
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), 30_000);
        const dispatcher = this._dispatcher ?? (0, http_js_1.getAuthDispatcher)(this._env);
        let response;
        try {
            response = await this._fetchImpl(url, {
                method: 'POST',
                headers: {
                    // Authorization: Basic <base64(clientId:clientSecret)>
                    // @see references/viva-docs/md/oauth2-authentication.txt:166
                    Authorization: `Basic ${credentials}`,
                    // Content-Type required for form-encoded body.
                    // @see references/viva-docs/md/oauth2-authentication.txt:165
                    'Content-Type': 'application/x-www-form-urlencoded',
                    Accept: 'application/json',
                },
                // grant_type=client_credentials
                // @see references/viva-docs/md/oauth2-authentication.txt:167
                body: 'grant_type=client_credentials',
                signal: controller.signal,
                // undici 7 supports the `dispatcher` option on global fetch.
                // @ts-expect-error undici dispatcher option not in standard fetch types
                dispatcher,
            });
        }
        catch (err) {
            clearTimeout(timer);
            // Network / abort error — caller handles retry policy (plan Auth Flow line 316).
            throw new api_error_js_1.VivaApiError({
                message: `Network error fetching Viva token: ${String(err)}`,
                cause: err,
            });
        }
        clearTimeout(timer);
        const requestId = response.headers.get('CorrelationId') ?? undefined;
        if (response.status === 401 || response.status === 403) {
            throw new auth_error_js_1.VivaAuthError({
                message: `Viva token endpoint returned ${response.status}. Check client credentials.`,
                httpStatus: response.status,
                requestId,
            });
        }
        if (response.status === 429) {
            const retryAfterHeader = response.headers.get('Retry-After');
            const retryAfterMs = retryAfterHeader ? parseFloat(retryAfterHeader) * 1000 : undefined;
            throw new rate_limit_error_js_1.VivaRateLimitError({
                message: 'Viva token endpoint rate-limited (429).',
                httpStatus: 429,
                requestId,
                retryAfterMs,
            });
        }
        if (response.status >= 500) {
            throw new rate_limit_error_js_1.VivaRateLimitError({
                message: `Viva token endpoint server error (${response.status}). Retriable.`,
                httpStatus: response.status,
                requestId,
            });
        }
        if (!response.ok) {
            throw new api_error_js_1.VivaApiError({
                message: `Unexpected status ${response.status} from Viva token endpoint.`,
                httpStatus: response.status,
                requestId,
            });
        }
        // Parse the OAuth2TokenResponse.
        // @see references/viva-docs/md/oauth2-authentication.txt:185 (response JSON shape)
        const body = (await response.json());
        // Compute expiry: now + (expires_in * 1000) - 60_000 (1-min safety margin).
        // Plan Auth Flow step 4 / line 314: store expires_at = now + expires_in - 60s.
        // @see references/viva-docs/md/oauth2-authentication.txt:192 (expires_in = 3600)
        const expires_at = this._now() + body.expires_in * 1000 - 60_000;
        await this._cache.set(this._cacheKey, {
            access_token: body.access_token,
            expires_at,
            scope: body.scope,
        });
        this._logger?.info('viva:auth:token-refresh', { environment: this._env });
        return body.access_token;
    }
}
exports.OAuth2ClientCredentialsStrategy = OAuth2ClientCredentialsStrategy;
//# sourceMappingURL=oauth2-strategy.js.map