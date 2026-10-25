/**
 * Single-flight primitives for token refresh.
 *
 * `AsyncMutex` serializes concurrent in-process callers on a single key.
 * `singleFlight()` ensures that when N callers race, only one fn() executes
 * and all N receive the same resolved value.
 *
 * For multi-worker deployments a Redis-based lock must be injected via
 * `RedisLockClient`. The interface is declared here; no Redis runtime dep
 * is included in this package — the SaaS layer provides the concrete impl.
 *
 * Plan ref (A1): forceRefresh on 401 recovery MUST go through the same
 * single-flight to prevent token stampede during secret rotation.
 */
export interface RedisLockClient {
    /**
     * Try to acquire a distributed lock for `key` with the given TTL.
     * Returns `{ token }` on success, `null` if the lock is already held.
     */
    acquire(key: string, ttlMs: number): Promise<{
        token: string;
    } | null>;
    /** Release the lock identified by `key` and `token`. */
    release(key: string, token: string): Promise<void>;
    /**
     * Poll `getter` every `intervalMs` until it returns a non-null value
     * (meaning another worker wrote the result to cache) or `timeoutMs` elapses.
     */
    pollCacheUntil<T>(getter: () => Promise<T | null>, intervalMs: number, timeoutMs: number): Promise<T | null>;
}
/**
 * A no-op sentinel implementation that throws if actually invoked.
 * Satisfies the type when Redis is not configured; safe to pass as default
 * so callers don't need to guard for undefined.
 */
export declare const noopRedisLock: RedisLockClient;
/**
 * A simple in-process serialising mutex.
 *
 * `acquire()` returns a release function. Callers MUST call the release
 * function in a `finally` block to avoid deadlocks.
 *
 * Internally, each acquire appends a promise to a chain. When the current
 * holder calls release it resolves the next waiter.
 */
export declare class AsyncMutex {
    private _tail;
    /**
     * Acquires the mutex. Resolves when this caller holds the lock.
     * Returns a `release` function that MUST be called in `finally`.
     */
    acquire(): Promise<() => void>;
}
type Locks = {
    local: AsyncMutex;
} | {
    redis: RedisLockClient;
};
/**
 * Ensures that concurrent calls with the same `key` execute `fn` exactly once.
 * All concurrent waiters share the same promise and receive the same result.
 *
 * Design: the in-flight map is checked and populated BEFORE acquiring the mutex.
 * - If an entry exists: await it directly (no mutex needed, no fn() call).
 * - If no entry: create the shared promise, store it, then acquire the mutex
 *   for the re-check + fn() execution. Other concurrent callers that arrive
 *   between "check" and "set" will see the entry in the map on their first
 *   check and coalesce.
 *
 * When a `{ local: AsyncMutex }` is provided the mutex is used to serialise
 * the actual fn() execution. The map handles the N-1 waiters.
 *
 * When a `{ redis: RedisLockClient }` is provided the first worker to acquire
 * the Redis lock runs fn(). Other workers (including other processes) poll
 * the cache via `pollCacheUntil` until the result is available.
 *
 * @see plan line 311 — Redis lock key pattern: `viva:isv:token:lock:{client_id}`
 */
export declare function singleFlight<T>(key: string, fn: () => Promise<T>, locks: Locks): Promise<T>;
export {};
//# sourceMappingURL=single-flight.d.ts.map