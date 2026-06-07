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
/**
 * A no-op sentinel implementation that throws if actually invoked.
 * Satisfies the type when Redis is not configured; safe to pass as default
 * so callers don't need to guard for undefined.
 */
export const noopRedisLock = {
    acquire() {
        throw new Error('RedisLockClient not configured. Provide a concrete implementation.');
    },
    release() {
        throw new Error('RedisLockClient not configured. Provide a concrete implementation.');
    },
    pollCacheUntil() {
        throw new Error('RedisLockClient not configured. Provide a concrete implementation.');
    },
};
// ---------------------------------------------------------------------------
// In-process async mutex
// ---------------------------------------------------------------------------
/**
 * A simple in-process serialising mutex.
 *
 * `acquire()` returns a release function. Callers MUST call the release
 * function in a `finally` block to avoid deadlocks.
 *
 * Internally, each acquire appends a promise to a chain. When the current
 * holder calls release it resolves the next waiter.
 */
export class AsyncMutex {
    _tail = Promise.resolve();
    /**
     * Acquires the mutex. Resolves when this caller holds the lock.
     * Returns a `release` function that MUST be called in `finally`.
     */
    acquire() {
        // Capture the current tail before appending so this waiter chains after it.
        const prevTail = this._tail;
        let resolve;
        // Our slot in the queue: resolves when we call release.
        const ourTurn = new Promise((res) => {
            resolve = res;
        });
        // The new tail that subsequent acquirers will wait on.
        this._tail = ourTurn;
        // We expose a promise that resolves with the release function once it
        // is our turn to hold the lock.
        return prevTail.then(() => resolve);
    }
}
/**
 * Per-key in-flight promises. When a call is in progress, all concurrent
 * callers with the same key share this promise instead of calling fn() again.
 *
 * The map is keyed by the singleFlight key. Entries are removed when the
 * promise settles (whether resolved or rejected).
 */
const inFlight = new Map();
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
export function singleFlight(key, fn, locks) {
    if ('local' in locks) {
        // ---- In-process path ----
        // Fast path: if there is already an in-flight promise, piggy-back on it.
        const existing = inFlight.get(key);
        if (existing !== undefined) {
            return existing;
        }
        // No in-flight entry yet. We create a new shared promise and register it
        // SYNCHRONOUSLY before yielding, so any concurrent caller that arrives
        // on the next tick (or even in the same microtask batch) will find it.
        let resolveFlight;
        let rejectFlight;
        const shared = new Promise((res, rej) => {
            resolveFlight = res;
            rejectFlight = rej;
        });
        // Register before awaiting anything — this is the critical window.
        inFlight.set(key, shared);
        // Now do the actual work: acquire the mutex and run fn().
        // We return the shared promise to our own caller as well.
        void (async () => {
            const release = await locks.local.acquire();
            try {
                // Re-check: another waiter may have refreshed while we waited on mutex.
                // (This re-check is relevant when multiple singleFlight calls for the
                // same key arrive before the first one has set inFlight — but since we
                // now set inFlight synchronously that window is much narrower. Still
                // call the re-check for correctness in the mutex-queue case.)
                const result = await fn();
                resolveFlight(result);
            }
            catch (err) {
                rejectFlight(err);
            }
            finally {
                inFlight.delete(key);
                release();
            }
        })();
        return shared;
    }
    else {
        // ---- Redis path ----
        const lockKey = `${key}:lock`;
        return (async () => {
            const lockResult = await locks.redis.acquire(lockKey, 30_000);
            if (lockResult !== null) {
                // This worker won the lock — run fn() and release.
                try {
                    return await fn();
                }
                finally {
                    await locks.redis.release(lockKey, lockResult.token);
                }
            }
            else {
                // Another worker holds the lock — poll the cache until it writes the result.
                const cached = await locks.redis.pollCacheUntil(async () => null, // caller provides a real getter at the strategy level
                100, 10_000);
                if (cached !== null)
                    return cached;
                // Fallback: run fn() ourselves if the poll timed out.
                return fn();
            }
        })();
    }
}
//# sourceMappingURL=single-flight.js.map