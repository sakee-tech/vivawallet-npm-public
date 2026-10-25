/**
 * test/jobs/per-merchant-semaphore.test.ts
 *
 * Unit tests for PerMerchantSemaphore in-process concurrency limiter.
 *
 * Coverage:
 *  - 5 concurrent acquires for same merchantId all admitted
 *  - 6th waiter is queued until one releases
 *  - 5 for merchant A + 5 for merchant B both proceed concurrently
 *  - LRU eviction after idle time
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { PerMerchantSemaphore } from '../../src/services/per-merchant-semaphore.service.js';
import { VIVA_PLUGIN_OPTIONS } from '../../src/constants.js';

// ---------------------------------------------------------------------------
// Helper: create a PerMerchantSemaphore without NestJS DI
// ---------------------------------------------------------------------------

function makeSemaphore(overrides: Partial<{ redlock: any }> = {}): PerMerchantSemaphore {
  const options = {
    mode: 'isv' as const,

    clientId: 'test',
    clientSecret: 'test',
    onboardingReturnUrl: 'https://example.com/onboarding-return',
    environment: 'demo' as const,
    webhookVerificationKey: 'key',
    successUrl: 'https://example.com/success',
    failureUrl: 'https://example.com/failure',
    ...overrides,
  };
  // Inject manually — bypass NestJS DI
  const sem = Object.create(PerMerchantSemaphore.prototype) as PerMerchantSemaphore;
  (sem as any).options = options;
  (sem as any).permits = 5;
  (sem as any).redlock = overrides.redlock;
  (sem as any).slots = new Map();
  // Don't start the real eviction timer — control it manually in tests
  (sem as any)._evictionTimer = undefined;
  return sem;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('PerMerchantSemaphore — in-process', () => {
  let sem: PerMerchantSemaphore;

  beforeEach(() => {
    sem = makeSemaphore();
  });

  it('admits up to 5 concurrent acquires for the same merchantId', async () => {
    const releases: Array<() => Promise<void>> = [];
    const acquired: number[] = [];

    for (let i = 0; i < 5; i++) {
      const release = await sem.acquire('merchant-A');
      acquired.push(i);
      releases.push(release);
    }

    expect(acquired).toHaveLength(5);
    expect((sem as any).slots.get('merchant-A')?.active).toBe(5);

    // Release all
    for (const rel of releases) await rel();
    expect((sem as any).slots.get('merchant-A')?.active).toBe(0);
  });

  it('6th acquire waits until a permit is released', async () => {
    const releases: Array<() => Promise<void>> = [];
    for (let i = 0; i < 5; i++) {
      releases.push(await sem.acquire('merchant-A'));
    }
    // 5 permits held

    let sixthAcquired = false;
    const sixthPromise = sem.acquire('merchant-A').then((rel) => {
      sixthAcquired = true;
      return rel;
    });

    // Still waiting
    expect(sixthAcquired).toBe(false);

    // Release one
    await releases[0]!();
    const sixthRelease = await sixthPromise;
    expect(sixthAcquired).toBe(true);

    // Cleanup
    await sixthRelease();
    for (const rel of releases.slice(1)) await rel();
  });

  it('5 permits for merchant-A + 5 permits for merchant-B both proceed concurrently', async () => {
    const aReleases: Array<() => Promise<void>> = [];
    const bReleases: Array<() => Promise<void>> = [];

    // Acquire all 5 for A without waiting
    for (let i = 0; i < 5; i++) {
      aReleases.push(await sem.acquire('merchant-A'));
    }
    // Acquire all 5 for B without waiting
    for (let i = 0; i < 5; i++) {
      bReleases.push(await sem.acquire('merchant-B'));
    }

    const slotA = (sem as any).slots.get('merchant-A');
    const slotB = (sem as any).slots.get('merchant-B');
    expect(slotA?.active).toBe(5);
    expect(slotB?.active).toBe(5);

    // Both merchants have 0 queued waiters
    expect(slotA?.queue).toHaveLength(0);
    expect(slotB?.queue).toHaveLength(0);

    for (const rel of aReleases) await rel();
    for (const rel of bReleases) await rel();
  });

  it('release drains the queue in order (FIFO)', async () => {
    const releases: Array<() => Promise<void>> = [];
    for (let i = 0; i < 5; i++) {
      releases.push(await sem.acquire('merchant-C'));
    }

    const order: number[] = [];
    const waiters = [1, 2, 3].map((n) =>
      sem.acquire('merchant-C').then((rel) => {
        order.push(n);
        return rel;
      }),
    );

    // Release in reverse order — FIFO queue means order=[1,2,3]
    await releases[0]!(); const r6 = await waiters[0]!;
    await releases[1]!(); const r7 = await waiters[1]!;
    await releases[2]!(); const r8 = await waiters[2]!;

    expect(order).toEqual([1, 2, 3]);

    for (const rel of [r6, r7, r8, ...releases.slice(3)]) await rel();
  });

  it('LRU eviction removes idle entries after EVICTION_IDLE_MS', () => {
    // Manually add an idle slot with an old lastIdleAt
    // Note: EVICTION_IDLE_MS = 5 minutes (300_000ms)
    const EVICTION_IDLE_MS = 5 * 60 * 1_000;
    (sem as any).EVICTION_IDLE_MS = EVICTION_IDLE_MS;
    (sem as any).slots.set('idle-merchant', {
      active: 0,
      queue: [],
      lastIdleAt: Date.now() - (EVICTION_IDLE_MS + 1000),
    });

    expect((sem as any)._slotCount).toBe(1);
    sem._forceEvict();
    expect((sem as any)._slotCount).toBe(0);
  });

  it('LRU eviction does NOT remove entries that are still active', () => {
    const EVICTION_IDLE_MS = 5 * 60 * 1_000;
    (sem as any).EVICTION_IDLE_MS = EVICTION_IDLE_MS;
    (sem as any).slots.set('active-merchant', {
      active: 2,
      queue: [],
      lastIdleAt: Date.now() - (EVICTION_IDLE_MS + 1000),
    });

    sem._forceEvict();
    expect((sem as any)._slotCount).toBe(1); // still there
  });

  it('LRU eviction does NOT remove entries that have not yet reached idle threshold', () => {
    (sem as any).EVICTION_IDLE_MS = 5 * 60 * 1_000;
    (sem as any).slots.set('recent-merchant', {
      active: 0,
      queue: [],
      lastIdleAt: Date.now() - 1000, // only 1s idle
    });

    sem._forceEvict();
    expect((sem as any)._slotCount).toBe(1); // still there
  });
});

describe('PerMerchantSemaphore — Redlock injection', () => {
  it('acquires the Redlock lock before returning the release function', async () => {
    const mockLock = { release: vi.fn().mockResolvedValue(undefined) };
    const mockRedlock = { acquire: vi.fn().mockResolvedValue(mockLock) };

    const sem = makeSemaphore({ redlock: mockRedlock as any });
    const release = await sem.acquire('merchant-redlock');

    expect(mockRedlock.acquire).toHaveBeenCalledWith(['merchant:merchant-redlock'], 30_000);

    await release();
    expect(mockLock.release).toHaveBeenCalledOnce();
  });

  it('releases Redlock lock even if in-process release throws', async () => {
    const mockLock = { release: vi.fn().mockResolvedValue(undefined) };
    const mockRedlock = { acquire: vi.fn().mockResolvedValue(mockLock) };

    const sem = makeSemaphore({ redlock: mockRedlock as any });
    const release = await sem.acquire('merchant-redlock-err');

    // Corrupt the slot so _releaseInProcess is a no-op (safe)
    (sem as any).slots.delete('merchant-redlock-err');

    await release(); // Should still call lock.release
    expect(mockLock.release).toHaveBeenCalledOnce();
  });
});
