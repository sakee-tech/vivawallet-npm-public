/**
 * per-tenant-semaphore.ts — In-process concurrency limiter keyed by tenant ID.
 *
 * Design choice (A11): in-process semaphore, not Redis-backed.
 * Rationale: the plan requires per-tenant concurrency=5. Medusa v2's built-in
 * job queue does not expose native per-key concurrency limits. A Redis-backed
 * distributed semaphore would require an extra Redis dependency and coordination
 * overhead. For a single-worker deployment (the common plugin scenario) an
 * in-process semaphore is correct and zero-latency.
 *
 * Multi-worker note: in a horizontally-scaled deployment each worker has its own
 * semaphore so effective concurrency per worker is 5, not 5 across all workers.
 * If true cross-worker limiting is needed, S10/S11 should upgrade to a Redis
 * semaphore (e.g. Redlock + a counting key). Document that upgrade path here.
 *
 * Memory: tenant entries are pruned from the map when `active=0` AND `waiters`
 * is empty, preventing unbounded growth after tenant churn.
 */

interface SemaphoreSlot {
  active: number;
  waiters: Array<() => void>;
}

/**
 * In-process per-tenant concurrency semaphore.
 *
 * Usage:
 *   const sem = new PerTenantSemaphore(5);
 *   const release = await sem.acquire('tenant-123');
 *   try { ... } finally { release(); }
 */
export class PerTenantSemaphore {
  private readonly slots = new Map<string, SemaphoreSlot>();

  constructor(private readonly maxConcurrency: number) {}

  /**
   * Acquire a slot for the given tenant key.
   * Resolves immediately if `active < maxConcurrency`, otherwise queues.
   * Returns a release function — MUST be called in a finally block.
   */
  acquire(tenantKey: string): Promise<() => void> {
    let slot = this.slots.get(tenantKey);
    if (!slot) {
      slot = { active: 0, waiters: [] };
      this.slots.set(tenantKey, slot);
    }

    const s = slot;

    if (s.active < this.maxConcurrency) {
      s.active++;
      return Promise.resolve(this.makeRelease(tenantKey, s));
    }

    // Queue: push a resolver and wait.
    return new Promise<() => void>((resolve) => {
      s.waiters.push(() => {
        s.active++;
        resolve(this.makeRelease(tenantKey, s));
      });
    });
  }

  private makeRelease(tenantKey: string, s: SemaphoreSlot): () => void {
    return () => {
      s.active--;
      if (s.waiters.length > 0) {
        const next = s.waiters.shift()!;
        next();
      } else if (s.active === 0) {
        // Prune empty entries (no waiters, no active) to prevent map growth.
        this.slots.delete(tenantKey);
      }
    };
  }

  /** For testing: current active count for a tenant. */
  activeCount(tenantKey: string): number {
    return this.slots.get(tenantKey)?.active ?? 0;
  }

  /** For testing: number of waiters queued for a tenant. */
  waiterCount(tenantKey: string): number {
    return this.slots.get(tenantKey)?.waiters.length ?? 0;
  }

  /** For testing: total number of tracked tenant keys. */
  trackedKeys(): number {
    return this.slots.size;
  }
}

/** Module-level singleton with the plan-specified max concurrency of 5. */
export const defaultSemaphore = new PerTenantSemaphore(5);
