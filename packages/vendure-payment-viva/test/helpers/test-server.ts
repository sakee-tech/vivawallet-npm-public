/**
 * test/helpers/test-server.ts — Vendure test server bootstrap helper.
 *
 * Reusable across V4–V11 tests that require the full Vendure application context
 * (NestJS DI, Vendure services, GraphQL API, etc.).
 *
 * For entity-only tests (V3) that only need a raw Postgres connection, use
 * test/helpers/db.ts directly — it is lighter and doesn't require a full
 * Vendure bootstrap.
 *
 * Usage (from a test file):
 * ```ts
 * import { bootstrapTestServer, teardownTestServer } from '../helpers/test-server.js';
 *
 * let server: Awaited<ReturnType<typeof bootstrapTestServer>>;
 *
 * beforeAll(async () => { server = await bootstrapTestServer([MyPlugin]); });
 * afterAll(async () => { await teardownTestServer(server); });
 * ```
 */

import { createTestEnvironment, registerInitializer, SqljsInitializer } from '@vendure/testing';
import type { VendureConfig } from '@vendure/core';
import { DefaultLogger, LogLevel } from '@vendure/core';

// Register a SQLite in-memory initializer for fast unit-style tests.
// For integration tests against Postgres, call createTestEnvironment() directly
// with a postgres DataSourceOptions config (see vendure/testing docs).
registerInitializer('sqljs', new SqljsInitializer('__test_db__'));

export interface TestServerOptions {
  /** Additional plugins to register. */
  plugins?: VendureConfig['plugins'];
  /** Override default log level (defaults to Warn to suppress noise). */
  logLevel?: LogLevel;
}

export interface TestServerHandle {
  server: ReturnType<typeof createTestEnvironment>['server'];
  adminClient: ReturnType<typeof createTestEnvironment>['adminClient'];
  shopClient: ReturnType<typeof createTestEnvironment>['shopClient'];
}

/**
 * Bootstraps a throwaway Vendure test server with the given plugins.
 *
 * Uses @vendure/testing's SqljsInitializer (SQLite in-memory) for speed.
 * Not suitable for testing Postgres-specific DDL (use db.ts helpers instead).
 */
export async function bootstrapTestServer(
  options: TestServerOptions = {},
): Promise<TestServerHandle> {
  const { server, adminClient, shopClient } = createTestEnvironment({
    logger: new DefaultLogger({ level: options.logLevel ?? LogLevel.Warn }),
    plugins: options.plugins ?? [],
  });

  await server.init({
    initialData: {
      defaultLanguage: 'en' as any,
      defaultZone: 'UK',
      taxRates: [],
      shippingMethods: [],
      countries: [],
      collections: [],
    },
    productsCsvPath: undefined as any,
    customerCount: 0,
  });

  return { server, adminClient, shopClient };
}

export async function teardownTestServer(handle: TestServerHandle): Promise<void> {
  await handle.server.destroy();
}
