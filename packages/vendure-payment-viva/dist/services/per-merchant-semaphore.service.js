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
var __decorate = (this && this.__decorate) || function (decorators, target, key, desc) {
    var c = arguments.length, r = c < 3 ? target : desc === null ? desc = Object.getOwnPropertyDescriptor(target, key) : desc, d;
    if (typeof Reflect === "object" && typeof Reflect.decorate === "function") r = Reflect.decorate(decorators, target, key, desc);
    else for (var i = decorators.length - 1; i >= 0; i--) if (d = decorators[i]) r = (c < 3 ? d(r) : c > 3 ? d(target, key, r) : d(target, key)) || r;
    return c > 3 && r && Object.defineProperty(target, key, r), r;
};
var __metadata = (this && this.__metadata) || function (k, v) {
    if (typeof Reflect === "object" && typeof Reflect.metadata === "function") return Reflect.metadata(k, v);
};
var __param = (this && this.__param) || function (paramIndex, decorator) {
    return function (target, key) { decorator(target, key, paramIndex); }
};
import { Injectable, Inject } from '@nestjs/common';
import { PER_MERCHANT_SEMAPHORE_PERMITS, VIVA_PLUGIN_OPTIONS } from '../constants.js';
// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------
let PerMerchantSemaphore = class PerMerchantSemaphore {
    options;
    slots = new Map();
    permits;
    redlock;
    // LRU eviction timer handle
    _evictionTimer;
    // Exposed for tests
    EVICTION_IDLE_MS = 5 * 60 * 1_000; // 5 minutes
    constructor(options) {
        this.options = options;
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
    async acquire(merchantId) {
        // 1. Acquire distributed lock (if configured)
        let redlockRelease;
        if (this.redlock) {
            const lock = await this.redlock.acquire([`merchant:${merchantId}`], 30_000);
            redlockRelease = () => lock.release();
        }
        // 2. Acquire in-process slot
        await this._acquireInProcess(merchantId);
        return async () => {
            try {
                if (redlockRelease)
                    await redlockRelease();
            }
            finally {
                this._releaseInProcess(merchantId);
            }
        };
    }
    // ---------------------------------------------------------------------------
    // In-process semaphore helpers
    // ---------------------------------------------------------------------------
    _getSlot(merchantId) {
        let slot = this.slots.get(merchantId);
        if (!slot) {
            slot = { active: 0, queue: [], lastIdleAt: Date.now() };
            this.slots.set(merchantId, slot);
        }
        return slot;
    }
    _acquireInProcess(merchantId) {
        const slot = this._getSlot(merchantId);
        if (slot.active < this.permits) {
            slot.active++;
            return Promise.resolve();
        }
        // Queue the waiter
        return new Promise((resolve) => {
            slot.queue.push(resolve);
        });
    }
    _releaseInProcess(merchantId) {
        const slot = this.slots.get(merchantId);
        if (!slot)
            return;
        const next = slot.queue.shift();
        if (next) {
            // hand the permit directly to the next waiter (active count unchanged)
            next();
        }
        else {
            slot.active = Math.max(0, slot.active - 1);
            if (slot.active === 0) {
                slot.lastIdleAt = Date.now();
            }
        }
    }
    // ---------------------------------------------------------------------------
    // LRU eviction
    // ---------------------------------------------------------------------------
    _startEvictionTimer() {
        // Run every minute; evict entries idle for >5 min with no active/queued holders
        this._evictionTimer = setInterval(() => {
            this._evict();
        }, 60_000);
        // Don't block the Node.js event loop from exiting
        if (this._evictionTimer.unref)
            this._evictionTimer.unref();
    }
    _evict() {
        const now = Date.now();
        for (const [merchantId, slot] of this.slots.entries()) {
            if (slot.active === 0 && slot.queue.length === 0 && now - slot.lastIdleAt > this.EVICTION_IDLE_MS) {
                this.slots.delete(merchantId);
            }
        }
    }
    /** @internal Force an eviction pass (for tests). */
    _forceEvict() {
        this._evict();
    }
    /** @internal Snapshot of current slot map size (for tests). */
    get _slotCount() {
        return this.slots.size;
    }
    onApplicationShutdown() {
        if (this._evictionTimer) {
            clearInterval(this._evictionTimer);
        }
    }
};
PerMerchantSemaphore = __decorate([
    Injectable(),
    __param(0, Inject(VIVA_PLUGIN_OPTIONS)),
    __metadata("design:paramtypes", [Object])
], PerMerchantSemaphore);
export { PerMerchantSemaphore };
//# sourceMappingURL=per-merchant-semaphore.service.js.map