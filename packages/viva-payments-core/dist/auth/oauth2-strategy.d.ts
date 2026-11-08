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
import type { Dispatcher } from 'undici';
import type { AuthStrategy } from '../types/auth.js';
import type { VivaEnvironment } from '../types/common.js';
import { AsyncMutex } from './single-flight.js';
import type { RedisLockClient } from './single-flight.js';
import type { TokenCache } from './token-cache.js';
import type { MetricsHook, Logger } from '../observability/index.js';
export interface OAuth2StrategyOptions {
    /** Target environment — determines token endpoint host. */
    environment: VivaEnvironment;
    /** OAuth2 Client ID. @see references/viva-docs/md/oauth2-authentication.txt:119 */
    clientId: string;
    /** OAuth2 Client Secret. @see references/viva-docs/md/oauth2-authentication.txt:119 */
    clientSecret: string;
    /** Token cache implementation. Defaults to `InMemoryTokenCache`. */
    cache?: TokenCache;
    /** In-process mutex. Defaults to a fresh `AsyncMutex`. */
    mutex?: AsyncMutex;
    /**
     * Redis lock client for multi-worker deployments (plan P11).
     * When provided, single-flight uses Redis instead of the in-proc mutex.
     */
    redisLock?: RedisLockClient;
    /**
     * Milliseconds before expiry at which the token is proactively refreshed.
     * Default: 5 * 60_000 = 300_000 ms (T-5min, per plan P11 line 73).
     */
    refreshSkewMs?: number;
    /** Backoff between retries when used by the caller. Default: 500 ms. */
    retryBackoffMs?: number;
    /** Injectable fetch. Defaults to the global `fetch`. Tests pass MockAgent fetch. */
    fetchImpl?: typeof fetch;
    /** Dispatcher override. Tests inject a MockAgent here. */
    dispatcher?: Dispatcher;
    /** Injectable clock. Defaults to `Date.now`. */
    now?: () => number;
    /** Optional metrics hook. Records viva_auth_token_refresh_duration_seconds. */
    metrics?: MetricsHook;
    /** Optional logger. Emits structured info on each token refresh. */
    logger?: Logger;
}
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
export declare class OAuth2ClientCredentialsStrategy implements AuthStrategy {
    readonly name = "oauth2-client-credentials";
    private readonly _env;
    private readonly _clientId;
    private readonly _clientSecret;
    private readonly _cache;
    private readonly _mutex;
    private readonly _redisLock;
    private readonly _refreshSkewMs;
    private readonly _fetchImpl;
    private readonly _dispatcher;
    private readonly _now;
    private readonly _metrics;
    private readonly _logger;
    constructor(opts: OAuth2StrategyOptions);
    /** Exposes the token cache for auth-status inspection. */
    get tokenCache(): TokenCache;
    /** Cache key format: `viva:isv:token:{clientId}:{environment}` */
    private get _cacheKey();
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
    getBearerToken(opts?: {
        forceRefresh?: boolean;
    }): Promise<string>;
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
    private _fetchToken;
    private _doFetchToken;
}
//# sourceMappingURL=oauth2-strategy.d.ts.map