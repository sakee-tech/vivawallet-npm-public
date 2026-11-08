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

import { Injectable, Inject } from '@nestjs/common';
import { PER_MERCHANT_SEMAPHORE_PERMITS, VIVA_PLUGIN_OPTIONS } from '../constants.js';
import type { VivaPaymentPluginOptions, RedlockClient } from '../types.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type Release = () => Promise<void>;

interface MerchantSlot {
  active: number;
  queue: Array<() => void>;
  lastIdleAt: number;
}

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

@Injectable()
export class PerMerchantSemaphore {
  private readonly slots = new Map<string, MerchantSlot>();
  private readonly permits: number;
  private readonly redlock: RedlockClient | undefined;

  // LRU eviction timer handle
  private _evictionTimer: ReturnType<typeof setInterval> | undefined;

  // Exposed for tests
  readonly EVICTION_IDLE_MS = 5 * 60 * 1_000; // 5 minutes

  constructor(
    @Inject(VIVA_PLUGIN_OPTIONS) private readonly options: VivaPaymentPluginOptions,
  ) {
    this.permits = PER_MERCHANT_SEMAPHORE_PERMITS;
    this.redlock = options.redlock;
    this._startEvictionTimer();
  }

  /**
   * Acquire a semaphore permit for `merchantId`.
   *
   * Returns a `Release` function that MUST be called in a `finally` block.
   *
   * If a Redlock client is configured, a distributed lock is also acquired
   * before returning. The distributed lock is released together with the
   * in-process permit.
   */
  async acquire(merchantId: string): Promise<Release> {
    // 1. Acquire distributed lock (if configured)
    let redlockRelease: (() => Promise<void>) | undefined;
    if (this.redlock) {
      const lock = await this.redlock.acquire([`merchant:${merchantId}`], 30_000);
      redlockRelease = () => lock.release();
    }

    // 2. Acquire in-process slot
    await this._acquireInProcess(merchantId);

    return async () => {
      try {
        if (redlockRelease) await redlockRelease();
      } finally {
        this._releaseInProcess(merchantId);
      }
    };
  }

  // ---------------------------------------------------------------------------
  // In-process semaphore helpers
  // ---------------------------------------------------------------------------

  private _getSlot(merchantId: string): MerchantSlot {
    let slot = this.slots.get(merchantId);
    if (!slot) {
      slot = { active: 0, queue: [], lastIdleAt: Date.now() };
      this.slots.set(merchantId, slot);
    }
    return slot;
  }

  private _acquireInProcess(merchantId: string): Promise<void> {
    const slot = this._getSlot(merchantId);
    if (slot.active < this.permits) {
      slot.active++;
      return Promise.resolve();
    }
    // Queue the waiter
    return new Promise<void>((resolve) => {
      slot.queue.push(resolve);
    });
  }

  private _releaseInProcess(merchantId: string): void {
    const slot = this.slots.get(merchantId);
    if (!slot) return;

    const next = slot.queue.shift();
    if (next) {
      // hand the permit directly to the next waiter (active count unchanged)
      next();
    } else {
      slot.active = Math.max(0, slot.active - 1);
      if (slot.active === 0) {
        slot.lastIdleAt = Date.now();
      }
    }
  }

  // ---------------------------------------------------------------------------
  // LRU eviction
  // ---------------------------------------------------------------------------

  private _startEvictionTimer(): void {
    // Run every minute; evict entries idle for >5 min with no active/queued holders
    this._evictionTimer = setInterval(() => {
      this._evict();
    }, 60_000);
    // Don't block the Node.js event loop from exiting
    if (this._evictionTimer.unref) this._evictionTimer.unref();
  }

  private _evict(): void {
    const now = Date.now();
    for (const [merchantId, slot] of this.slots.entries()) {
      if (slot.active === 0 && slot.queue.length === 0 && now - slot.lastIdleAt > this.EVICTION_IDLE_MS) {
        this.slots.delete(merchantId);
      }
    }
  }

  /** @internal Force an eviction pass (for tests). */
  _forceEvict(): void {
    this._evict();
  }

  /** @internal Snapshot of current slot map size (for tests). */
  get _slotCount(): number {
    return this.slots.size;
  }

  onApplicationShutdown(): void {
    if (this._evictionTimer) {
      clearInterval(this._evictionTimer);
    }
  }
}
