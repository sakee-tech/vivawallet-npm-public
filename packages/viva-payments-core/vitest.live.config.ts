import { defineConfig } from 'vitest/config';

/**
 * LIVE integration test config — hits the real Viva demo environment.
 *
 * Separate from the default (mocked) suite so `pnpm test` stays hermetic.
 * Run explicitly with `pnpm test:live`. Requires Viva demo credentials in
 * `.env` at the repo root (loaded by `test/live/_setup.ts`); tests for which
 * the required vars are absent self-skip rather than fail.
 *
 * Conventions for live runs (see docs/resume — "run once, report, stop"):
 *   - singleFork + sequential: no parallel hammering of the demo API, and
 *     ordered output that's easy to read in a single pass.
 *   - retry: 0: a live failure is a real signal — never silently re-run.
 *   - generous timeouts: real network + OAuth round-trips.
 */
export default defineConfig({
  test: {
    include: ['test/live/**/*.live.test.ts'],
    setupFiles: ['test/live/_setup.ts'],
    testTimeout: 30_000,
    hookTimeout: 30_000,
    retry: 0,
    fileParallelism: false,
    pool: 'forks',
    poolOptions: { forks: { singleFork: true } },
    sequence: { concurrent: false },
  },
});
