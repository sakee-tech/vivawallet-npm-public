/**
 * services/per-merchant-semaphore.service.ts — In-process per-merchant concurrency semaphore.
 *
 * Limits concurrent webhook processing per merchantId to PER_MERCHANT_SEMAPHORE_PERMITS
 * (default 5) per worker process, matching Medusa A11.
 *
 * Optional Redlock injection: when `redlock` is set in plugin options the service
 * acquires a Redis-backed distributed lock on `merchant:{merchantId}` before
 * entering the in-process semaphore. Release always happens in `finally`.
 *
 * LRU: idle merchant entries (no waiting/active holders) are evicted after 5 min.
 *
 * Multi-worker note: without Redlock the cap is PERMITS × WORKERS (each worker has
 * its own independent in-process counter — no global coordination).
 *
 * @see docs/plans/vendure-plugin-v0.md §"Webhook Design — Per-tenant concurrency" D9
 */
import type { VivaPaymentPluginOptions } from '../types.js';
export type Release = () => Promise<void>;
export declare class PerMerchantSemaphore {
    private readonly options;
    private readonly slots;
    private readonly permits;
    private readonly redlock;
    private _evictionTimer;
    readonly EVICTION_IDLE_MS: number;
    constructor(options: VivaPaymentPluginOptions);
    /**
     * Acquire a semaphore permit for `merchantId`.
     *
     * Returns a `Release` function that MUST be called in a `finally` block.
     *
     * If a Redlock client is configured, a distributed lock is also acquired
     * before returning. The distributed lock is released together with the
     * in-process permit.
     */
    acquire(merchantId: string): Promise<Release>;
    private _getSlot;
    private _acquireInProcess;
    private _releaseInProcess;
    private _startEvictionTimer;
    private _evict;
    /** @internal Force an eviction pass (for tests). */
    _forceEvict(): void;
    /** @internal Snapshot of current slot map size (for tests). */
    get _slotCount(): number;
    onApplicationShutdown(): void;
}
//# sourceMappingURL=per-merchant-semaphore.service.d.ts.map