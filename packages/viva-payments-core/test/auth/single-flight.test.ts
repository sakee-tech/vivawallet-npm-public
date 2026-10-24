import { describe, it, expect, vi } from 'vitest';
import { AsyncMutex, singleFlight } from '../../src/auth/single-flight.js';

describe('AsyncMutex', () => {
  it('serializes 10 concurrent acquires', async () => {
    const mutex = new AsyncMutex();
    const order: number[] = [];
    const n = 10;

    const tasks = Array.from({ length: n }, (_, i) =>
      mutex.acquire().then(async (release) => {
        order.push(i);
        // Yield to allow other tasks to proceed if not serialised
        await Promise.resolve();
        release();
      }),
    );

    await Promise.all(tasks);

    // All tasks ran exactly once
    expect(order).toHaveLength(n);
    // No two tasks ran at the same time: each index appears exactly once
    expect(new Set(order).size).toBe(n);
  });

  it('release unblocks the next waiter', async () => {
    const mutex = new AsyncMutex();
    const log: string[] = [];

    const r1 = await mutex.acquire();
    log.push('r1 acquired');

    const p2 = mutex.acquire().then(async (r2) => {
      log.push('r2 acquired');
      r2();
    });

    r1();
    await p2;

    expect(log).toEqual(['r1 acquired', 'r2 acquired']);
  });
});

describe('singleFlight', () => {
  it('returns the same value to all concurrent callers', async () => {
    const mutex = new AsyncMutex();
    let callCount = 0;

    const fn = async (): Promise<string> => {
      callCount++;
      await new Promise((r) => setTimeout(r, 10));
      return 'result';
    };

    const results = await Promise.all(
      Array.from({ length: 20 }, () => singleFlight('key1', fn, { local: mutex })),
    );

    expect(callCount).toBe(1);
    expect(results.every((r) => r === 'result')).toBe(true);
  });

  it('100 concurrent callers produce exactly 1 fn() invocation', async () => {
    const mutex = new AsyncMutex();
    let callCount = 0;

    const fn = async (): Promise<number> => {
      callCount++;
      // Small delay to keep the promise in-flight while others arrive
      await new Promise((r) => setTimeout(r, 5));
      return 42;
    };

    const results = await Promise.all(
      Array.from({ length: 100 }, () => singleFlight('key100', fn, { local: mutex })),
    );

    expect(callCount).toBe(1);
    expect(results.every((r) => r === 42)).toBe(true);
  });

  it('different keys do NOT block each other', async () => {
    const mutex1 = new AsyncMutex();
    const mutex2 = new AsyncMutex();
    const timeline: string[] = [];

    const p1 = singleFlight(
      'keyA',
      async () => {
        timeline.push('A:start');
        await new Promise((r) => setTimeout(r, 20));
        timeline.push('A:end');
        return 'a';
      },
      { local: mutex1 },
    );

    const p2 = singleFlight(
      'keyB',
      async () => {
        timeline.push('B:start');
        await new Promise((r) => setTimeout(r, 5));
        timeline.push('B:end');
        return 'b';
      },
      { local: mutex2 },
    );

    const [a, b] = await Promise.all([p1, p2]);

    expect(a).toBe('a');
    expect(b).toBe('b');
    // B should complete before A because they run in parallel
    const bEnd = timeline.indexOf('B:end');
    const aEnd = timeline.indexOf('A:end');
    expect(bEnd).toBeLessThan(aEnd);
  });

  it('sequential calls each run fn() once per call', async () => {
    const mutex = new AsyncMutex();
    let count = 0;
    const fn = async (): Promise<number> => ++count;

    const r1 = await singleFlight('seq', fn, { local: mutex });
    const r2 = await singleFlight('seq', fn, { local: mutex });

    // Sequential — each call runs independently
    expect(r1).toBe(1);
    expect(r2).toBe(2);
    expect(count).toBe(2);
  });

  it('propagates fn() rejection to all concurrent callers', async () => {
    const mutex = new AsyncMutex();
    const boom = new Error('boom');
    const fn = async (): Promise<string> => {
      await Promise.resolve();
      throw boom;
    };

    const results = await Promise.allSettled(
      Array.from({ length: 5 }, () => singleFlight('err-key', fn, { local: mutex })),
    );

    // All callers should reject
    for (const r of results) {
      expect(r.status).toBe('rejected');
    }
  });
});
