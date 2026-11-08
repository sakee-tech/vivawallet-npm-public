/**
 * TokenCache interface and built-in implementations.
 *
 * `InMemoryTokenCache` is the default for single-worker deployments.
 * `RedisTokenCache` is declared as an interface; the SaaS layer provides
 * the concrete implementation via dependency injection (plan P11, Q3).
 */
import type { CachedToken } from '../types/auth.js';
export interface TokenCache {
    get(key: string): Promise<CachedToken | null>;
    set(key: string, value: CachedToken): Promise<void>;
    delete(key: string): Promise<void>;
}
export declare class InMemoryTokenCache implements TokenCache {
    private readonly _store;
    /** Injectable clock; defaults to `Date.now`. Allows time-travel in tests. */
    private readonly _now;
    constructor(opts?: {
        now?: () => number;
    });
    get(key: string): Promise<CachedToken | null>;
    set(key: string, value: CachedToken): Promise<void>;
    delete(key: string): Promise<void>;
}
/**
 * Redis-backed token cache interface.
 *
 * The concrete implementation lives in the SaaS package. It is injected via
 * `OAuth2ClientCredentialsStrategy.cache` option at construction time.
 *
 * Plan Q3: the interface is published from day one so future adapters
 * (Memcached, ElastiCache) are additive, not structural changes.
 */
export interface RedisTokenCacheClient {
    get(key: string): Promise<string | null>;
    set(key: string, value: string, ttlMs: number): Promise<void>;
    delete(key: string): Promise<void>;
}
/**
 * Thin wrapper that adapts a `RedisTokenCacheClient` to the `TokenCache`
 * interface by JSON-serialising `CachedToken` values.
 */
export declare class RedisTokenCache implements TokenCache {
    private readonly client;
    constructor(client: RedisTokenCacheClient);
    get(key: string): Promise<CachedToken | null>;
    set(key: string, value: CachedToken): Promise<void>;
    delete(key: string): Promise<void>;
}
//# sourceMappingURL=token-cache.d.ts.map