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
import type { AuthStrategy, OAuth2TokenResponse } from '../types/auth.js';
import type { VivaEnvironment } from '../types/common.js';
import { ENVIRONMENT_URLS } from '../types/common.js';
import { VivaAuthError } from '../errors/auth-error.js';
import { VivaApiError } from '../errors/api-error.js';
import { VivaRateLimitError } from '../errors/rate-limit-error.js';
import { AsyncMutex, singleFlight } from './single-flight.js';
import type { RedisLockClient } from './single-flight.js';
import { InMemoryTokenCache } from './token-cache.js';
import type { TokenCache } from './token-cache.js';
import { getAuthDispatcher } from './http.js';
import type { MetricsHook, Logger } from '../observability/index.js';
import { NoopMetricsHook } from '../observability/index.js';

// ---------------------------------------------------------------------------
// Constructor options
// ---------------------------------------------------------------------------

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
export class OAuth2ClientCredentialsStrategy implements AuthStrategy {
  readonly name = 'oauth2-client-credentials';

  private readonly _env: VivaEnvironment;
  private readonly _clientId: string;
  private readonly _clientSecret: string;
  private readonly _cache: TokenCache;
  private readonly _mutex: AsyncMutex;
  private readonly _redisLock: RedisLockClient | undefined;
  private readonly _refreshSkewMs: number;
  private readonly _fetchImpl: typeof fetch;
  private readonly _dispatcher: Dispatcher | undefined;
  private readonly _now: () => number;
  private readonly _metrics: MetricsHook;
  private readonly _logger: Logger | undefined;

  constructor(opts: OAuth2StrategyOptions) {
    this._env = opts.environment;
    this._clientId = opts.clientId;
    this._clientSecret = opts.clientSecret;
    this._cache = opts.cache ?? new InMemoryTokenCache();
    this._mutex = opts.mutex ?? new AsyncMutex();
    this._redisLock = opts.redisLock;
    this._refreshSkewMs = opts.refreshSkewMs ?? 5 * 60_000;
    this._fetchImpl = opts.fetchImpl ?? globalThis.fetch;
    this._dispatcher = opts.dispatcher;
    this._now = opts.now ?? (() => Date.now());
    this._metrics = opts.metrics ?? new NoopMetricsHook();
    this._logger = opts.logger;
  }

  /** Exposes the token cache for auth-status inspection. */
  get tokenCache(): TokenCache {
    return this._cache;
  }

  /** Cache key format: `viva:isv:token:{clientId}:{environment}` */
  private get _cacheKey(): string {
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
  async getBearerToken(opts?: { forceRefresh?: boolean }): Promise<string> {
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
      ? ({ redis: this._redisLock } as const)
      : ({ local: this._mutex } as const);

    return singleFlight(
      this._cacheKey,
      async () => {
        // Re-check cache after acquiring the lock; another waiter may have
        // already refreshed the token while we were queued.
        if (!forceRefresh) {
          const reChecked = await this._cache.get(this._cacheKey);
          if (reChecked && reChecked.expires_at > this._now() + this._refreshSkewMs) {
            return reChecked.access_token;
          }
        }

        return this._fetchToken();
      },
      locks,
    );
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
  private async _fetchToken(): Promise<string> {
    return this._metrics.timeAsync(
      'viva_auth_token_refresh_duration_seconds',
      () => this._doFetchToken(),
    );
  }

  private async _doFetchToken(): Promise<string> {
    const { authBaseUrl } = ENVIRONMENT_URLS[this._env];
    const url = `${authBaseUrl}/connect/token`;

    // Base64-encode Client_ID:Client_Secret per Viva OAuth2 docs line 153.
    // @see references/viva-docs/md/oauth2-authentication.txt:153
    const credentials = Buffer.from(`${this._clientId}:${this._clientSecret}`).toString('base64');

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 30_000);

    const dispatcher = this._dispatcher ?? getAuthDispatcher(this._env);

    let response: Response;
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
    } catch (err) {
      clearTimeout(timer);
      // Network / abort error — caller handles retry policy (plan Auth Flow line 316).
      throw new VivaApiError({
        message: `Network error fetching Viva token: ${String(err)}`,
        cause: err,
      });
    }
    clearTimeout(timer);

    const requestId = response.headers.get('CorrelationId') ?? undefined;

    if (response.status === 401 || response.status === 403) {
      throw new VivaAuthError({
        message: `Viva token endpoint returned ${response.status}. Check client credentials.`,
        httpStatus: response.status,
        requestId,
      });
    }

    if (response.status === 429) {
      const retryAfterHeader = response.headers.get('Retry-After');
      const retryAfterMs = retryAfterHeader ? parseFloat(retryAfterHeader) * 1000 : undefined;
      throw new VivaRateLimitError({
        message: 'Viva token endpoint rate-limited (429).',
        httpStatus: 429,
        requestId,
        retryAfterMs,
      });
    }

    if (response.status >= 500) {
      throw new VivaRateLimitError({
        message: `Viva token endpoint server error (${response.status}). Retriable.`,
        httpStatus: response.status,
        requestId,
      });
    }

    if (!response.ok) {
      throw new VivaApiError({
        message: `Unexpected status ${response.status} from Viva token endpoint.`,
        httpStatus: response.status,
        requestId,
      });
    }

    // Parse the OAuth2TokenResponse.
    // @see references/viva-docs/md/oauth2-authentication.txt:185 (response JSON shape)
    const body = (await response.json()) as OAuth2TokenResponse;

    // Compute expiry: now + (expires_in * 1000) - 60_000 (1-min safety margin).
    // Plan Auth Flow step 4 / line 314: store expires_at = now + expires_in - 60s.
    // @see references/viva-docs/md/oauth2-authentication.txt:192 (expires_in = 3600)
    const expires_at = this._now() + body.expires_in * 1000 - 60_000;

    await this._cache.set(this._cacheKey, {
      access_token: body.access_token,
      expires_at,
      scope: body.scope,
    });

    this._logger?.info('viva:auth:token-refresh', { environment: this._env as string });

    return body.access_token;
  }
}
