/**
 * TokenCache interface and built-in implementations.
 *
 * `InMemoryTokenCache` is the default for single-worker deployments.
 * `RedisTokenCache` is declared as an interface; the SaaS layer provides
 * the concrete implementation via dependency injection (plan P11, Q3).
 */

import type { CachedToken } from '../types/auth.js';

// ---------------------------------------------------------------------------
// Interface
// ---------------------------------------------------------------------------

export interface TokenCache {
  get(key: string): Promise<CachedToken | null>;
  set(key: string, value: CachedToken): Promise<void>;
  delete(key: string): Promise<void>;
}

// ---------------------------------------------------------------------------
// In-memory implementation
// ---------------------------------------------------------------------------

export class InMemoryTokenCache implements TokenCache {
  private readonly _store = new Map<string, CachedToken>();

  /** Injectable clock; defaults to `Date.now`. Allows time-travel in tests. */
  private readonly _now: () => number;

  constructor(opts?: { now?: () => number }) {
    this._now = opts?.now ?? (() => Date.now());
  }

  async get(key: string): Promise<CachedToken | null> {
    const entry = this._store.get(key);
    if (!entry) return null;
    // Treat as expired if the current time is at or past `expires_at`.
    if (this._now() >= entry.expires_at) {
      this._store.delete(key);
      return null;
    }
    return entry;
  }

  async set(key: string, value: CachedToken): Promise<void> {
    this._store.set(key, value);
  }

  async delete(key: string): Promise<void> {
    this._store.delete(key);
  }
}

// ---------------------------------------------------------------------------
// Redis cache interface (declare only — no concrete Redis dep in core)
// ---------------------------------------------------------------------------

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
export class RedisTokenCache implements TokenCache {
  constructor(private readonly client: RedisTokenCacheClient) {}

  async get(key: string): Promise<CachedToken | null> {
    const raw = await this.client.get(key);
    if (!raw) return null;
    return JSON.parse(raw) as CachedToken;
  }

  async set(key: string, value: CachedToken): Promise<void> {
    const ttlMs = Math.max(0, value.expires_at - Date.now());
    await this.client.set(key, JSON.stringify(value), ttlMs);
  }

  async delete(key: string): Promise<void> {
    await this.client.delete(key);
  }
}
