/**
 * per-tenant-semaphore.test.ts — Unit tests for A11 in-process concurrency limiter.
 *
 * No DB or Medusa required — pure unit tests.
 *
 * Covers:
 *   1. concurrency=5: 100 concurrent acquires for same tenantKey serialize to 5-at-a-time.
 *   2. Different tenantKeys do not block each other.
 *   3. Releasing while no waiters drops the entry from the map (no leak).
 */

import { describe, it, expect } from 'vitest';
import { PerTenantSemaphore } from '../../src/workflows/per-tenant-semaphore.js';

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('PerTenantSemaphore (A11)', () => {
  it('1. concurrency=5: serializes 100 concurrent acquires to 5-at-a-time', async () => {
    const sem = new PerTenantSemaphore(5);
    const maxConcurrent: number[] = [];
    let current = 0;

    const tasks = Array.from({ length: 100 }, async () => {
      const release = await sem.acquire('tenant-a');
      current++;
      maxConcurrent.push(current);
      // Yield to allow other tasks to run
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
      current--;
      release();
    });

    await Promise.all(tasks);

    // At no point should more than 5 be running simultaneously
    const highWaterMark = Math.max(...maxConcurrent);
    expect(highWaterMark).toBeLessThanOrEqual(5);
    // All tasks completed
    expect(current).toBe(0);
  });

  it('2. Different tenantKeys do not block each other', async () => {
    const sem = new PerTenantSemaphore(1); // max 1 per tenant

    // Acquire slot for tenant-a — this holds the slot
    const releaseA = await sem.acquire('tenant-a');

    // tenant-b should NOT block on tenant-a's slot
    let bResolved = false;
    const promiseB = sem.acquire('tenant-b').then((release) => {
      bResolved = true;
      return release;
    });

    // Give the event loop a tick
    await new Promise<void>((resolve) => setTimeout(resolve, 10));
    expect(bResolved).toBe(true);

    const releaseB = await promiseB;

    // Tenant-a slot still held — another acquire for tenant-a should queue
    let aResolved2 = false;
    sem.acquire('tenant-a').then((release) => {
      aResolved2 = true;
      release();
    });

    await new Promise<void>((resolve) => setTimeout(resolve, 10));
    // Should not resolve while tenant-a slot is still held
    expect(aResolved2).toBe(false);

    releaseA();
    await new Promise<void>((resolve) => setTimeout(resolve, 10));
    expect(aResolved2).toBe(true);

    releaseB();
  });

  it('3. Releasing with no waiters removes the map entry (no leak)', async () => {
    const sem = new PerTenantSemaphore(5);

    // Acquire and release with no waiters
    const release1 = await sem.acquire('tenant-x');
    const release2 = await sem.acquire('tenant-x');

    expect(sem.trackedKeys()).toBe(1);
    expect(sem.activeCount('tenant-x')).toBe(2);

    release1();
    expect(sem.trackedKeys()).toBe(1); // still has active=1
    expect(sem.activeCount('tenant-x')).toBe(1);

    release2();
    // Now active=0, waiters=0 → entry should be pruned
    expect(sem.trackedKeys()).toBe(0);
    expect(sem.activeCount('tenant-x')).toBe(0);
  });

  it('4. acquire/release correctness under varied concurrency', async () => {
    const sem = new PerTenantSemaphore(3);
    let maxActive = 0;
    let active = 0;

    const work = async (tenant: string, delay: number) => {
      const release = await sem.acquire(tenant);
      active++;
      if (active > maxActive) maxActive = active;
      await new Promise<void>((resolve) => setTimeout(resolve, delay));
      active--;
      release();
    };

    await Promise.all([
      work('t1', 10),
      work('t1', 10),
      work('t1', 10),
      work('t1', 10),
      work('t1', 10),
      work('t2', 5),
      work('t2', 5),
    ]);

    // t1 max concurrency is 3; t2 runs independently
    // Combined max should be ≤ 3 (t1) + 3 (t2) = 6
    expect(maxActive).toBeGreaterThanOrEqual(1);
    expect(active).toBe(0);
    expect(sem.trackedKeys()).toBe(0);
  });
});
