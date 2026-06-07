/**
 * TokenCache interface and built-in implementations.
 *
 * `InMemoryTokenCache` is the default for single-worker deployments.
 * `RedisTokenCache` is declared as an interface; the SaaS layer provides
 * the concrete implementation via dependency injection (plan P11, Q3).
 */
// ---------------------------------------------------------------------------
// In-memory implementation
// ---------------------------------------------------------------------------
export class InMemoryTokenCache {
    _store = new Map();
    /** Injectable clock; defaults to `Date.now`. Allows time-travel in tests. */
    _now;
    constructor(opts) {
        this._now = opts?.now ?? (() => Date.now());
    }
    async get(key) {
        const entry = this._store.get(key);
        if (!entry)
            return null;
        // Treat as expired if the current time is at or past `expires_at`.
        if (this._now() >= entry.expires_at) {
            this._store.delete(key);
            return null;
        }
        return entry;
    }
    async set(key, value) {
        this._store.set(key, value);
    }
    async delete(key) {
        this._store.delete(key);
    }
}
/**
 * Thin wrapper that adapts a `RedisTokenCacheClient` to the `TokenCache`
 * interface by JSON-serialising `CachedToken` values.
 */
export class RedisTokenCache {
    client;
    constructor(client) {
        this.client = client;
    }
    async get(key) {
        const raw = await this.client.get(key);
        if (!raw)
            return null;
        return JSON.parse(raw);
    }
    async set(key, value) {
        const ttlMs = Math.max(0, value.expires_at - Date.now());
        await this.client.set(key, JSON.stringify(value), ttlMs);
    }
    async delete(key) {
        await this.client.delete(key);
    }
}
//# sourceMappingURL=token-cache.js.map