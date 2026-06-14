/**
 * test/plugin/boots-in-medusa.test.ts — "does it actually boot?" DI guard (#21).
 *
 * Boots the FULL plugin inside a real Medusa application via
 * medusaIntegrationTestRunner and asserts the #21 wiring:
 *
 *   1. The plugin loader registers `vivaPluginConfig` + `vivaOAuth2Strategy`
 *      on the app (root) container at boot.
 *   2. A request-style child scope resolves the config EVEN AFTER the VIVA_*
 *      env vars are deleted — proving the runtime (admin routes, subscriber,
 *      mode gate) reads the registered config from the container, not
 *      process.env. This is the exact regression #21 fixes; typecheck and unit
 *      tests cannot catch a DI/registration scoping failure.
 *
 * Requires Postgres (the runner creates a throwaway DB). Skips gracefully when
 * PG is unreachable (CI without a DB service), the same contract as the vendure
 * boot test. pgReachable is top-level awaited BEFORE the runner is invoked so
 * the skip is decided at collection time.
 */

import { describe, it, expect } from 'vitest';
import { medusaIntegrationTestRunner } from '@medusajs/test-utils';
import pg from 'pg';
import { VIVA_PLUGIN_CONFIG_KEY, VIVA_OAUTH2_STRATEGY_KEY } from '../../src/container.js';
import type { VivaPluginConfig } from '../../src/config.js';

const VIVA_ENV: Record<string, string> = {
  VIVA_MODE: 'isv',
  VIVA_ENVIRONMENT: 'demo',
  VIVA_CLIENT_ID: 'test-client-id',
  VIVA_CLIENT_SECRET: 'test-client-secret',
  VIVA_WEBHOOK_VERIFICATION_KEY: 'test-webhook-key',
  VIVA_MERCHANT_ID: 'test-merchant-id',
  VIVA_API_KEY: 'test-api-key',
  VIVA_RESELLER_ID: 'test-reseller-id',
  VIVA_RESELLER_MERCHANT_ID: 'test-reseller-merchant-id',
  VIVA_RESELLER_API_KEY: 'test-reseller-api-key',
  VIVA_ADMIN_TOKEN: 'test-admin-token',
};

async function pgReachable(): Promise<boolean> {
  const conn =
    process.env['DATABASE_URL'] ??
    `postgresql://${process.env['USER'] ?? 'postgres'}@localhost:5432/postgres`;
  const client = new pg.Client(conn);
  try {
    await client.connect();
    await client.end();
    return true;
  } catch {
    return false;
  }
}

const PG_OK = await pgReachable();

// Release gate (#26): a release must boot the plugin for real, not silently skip.
if (!PG_OK && process.env['VIVA_REQUIRE_PG']) {
  throw new Error(
    'VIVA_REQUIRE_PG is set but Postgres is unreachable — the release gate requires a live ' +
      'database so the plugin actually boots. Start Postgres and re-run.',
  );
}

if (!PG_OK) {
  describe.skip('boots-in-medusa (Postgres unreachable — skipped)', () => {
    it('skipped', () => {
      expect(true).toBe(true);
    });
  });
} else {
  // The runner requires medusa-config.js (which calls loadConfigFromEnv) BEFORE
  // it applies its own `env` option, so set the env at module load time — and
  // clear the ambient deprecated aliases so they don't shadow our values.
  delete process.env['VIVA_ISV_CLIENT_ID'];
  delete process.env['VIVA_ISV_CLIENT_SECRET'];
  for (const [key, value] of Object.entries(VIVA_ENV)) {
    process.env[key] = value;
  }

  // medusaIntegrationTestRunner's startApp does `process.send?.(port)` after the
  // HTTP server listens. Under vitest's fork pool, `process.send` is the worker
  // IPC channel, and a raw number corrupts vitest's message deserialization
  // (TypeError: Buffer.from(<number>)). Swallow numeric sends (the port
  // broadcast); pass vitest's object/buffer messages through untouched.
  const originalSend = process.send?.bind(process);
  if (originalSend) {
    process.send = ((message: unknown, ...rest: unknown[]): boolean => {
      if (typeof message === 'number') return true;
      return (originalSend as (...args: unknown[]) => boolean)(message, ...rest);
    }) as typeof process.send;
  }

  medusaIntegrationTestRunner({
    moduleName: 'viva-boot',
    cwd: new URL('../integration-app', import.meta.url).pathname,
    env: VIVA_ENV,
    testSuite: ({ getContainer }) => {
      it('loader registers vivaPluginConfig + strategy on the app container', () => {
        const container = getContainer();
        const config = container.resolve<VivaPluginConfig>(VIVA_PLUGIN_CONFIG_KEY);
        expect(config).toBeDefined();
        expect(config.mode).toBe('isv');
        expect(config.environment).toBe('demo');

        const strategy = container.resolve(VIVA_OAUTH2_STRATEGY_KEY);
        expect(strategy).toBeDefined();
      });

      it('request scope resolves config without reading process.env', () => {
        // Snapshot + delete all VIVA_* env so any lingering env read would fail.
        const saved: Record<string, string | undefined> = {};
        for (const key of Object.keys(VIVA_ENV)) {
          saved[key] = process.env[key];
          delete process.env[key];
        }
        try {
          // A child scope mimics the per-request scope admin routes resolve from.
          const reqScope = getContainer().createScope();
          const config = reqScope.resolve<VivaPluginConfig>(VIVA_PLUGIN_CONFIG_KEY);
          expect(config).toBeDefined();
          expect(config.mode).toBe('isv');
        } finally {
          for (const [key, value] of Object.entries(saved)) {
            if (value !== undefined) process.env[key] = value;
          }
        }
      });
    },
  });
}
