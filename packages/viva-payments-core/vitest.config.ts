import { defineConfig } from 'vitest/config';

/**
 * Default (mocked) test config.
 *
 * Runs the hermetic unit/scenario suite under `test/` — every HTTP call is
 * intercepted via undici MockAgent, so this is the suite that runs in CI and
 * on `pnpm test`. The LIVE integration suite under `test/live/**` is excluded
 * here and only runs via `pnpm test:live` (vitest.live.config.ts), which hits
 * the real Viva demo environment and requires credentials in `.env`.
 */
export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    exclude: ['**/node_modules/**', '**/dist/**', 'test/live/**'],
  },
});
