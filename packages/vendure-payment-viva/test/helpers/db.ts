/**
 * test/helpers/db.ts — Postgres test database lifecycle helpers for vendure-payment-viva.
 *
 * Creates a throwaway Postgres database per test run, applies migrations via raw
 * SQL (no full Vendure bootstrap needed for entity-level tests), and drops the DB
 * in afterAll.
 *
 * Reachability check is exported as a promise so test files can top-level await it
 * BEFORE their describe() block — avoids the vitest collection-order gotcha where
 * a skip inside beforeAll runs too late.
 *
 * Connection: DATABASE_URL env var, or
 *   postgresql://$USER@localhost:5432/postgres
 */

import pg from 'pg';

// ---------------------------------------------------------------------------
// Connection helpers
// ---------------------------------------------------------------------------

function getAdminConnString(): string {
  return (
    process.env['DATABASE_URL'] ??
    `postgresql://${process.env['USER'] ?? 'postgres'}@localhost:5432/postgres`
  );
}

export function getTestDbName(): string {
  return `viva_test_v3_${process.pid}`;
}

export function getTestConnString(): string {
  const admin = getAdminConnString();
  const dbName = getTestDbName();
  return admin.replace(/\/[^/]+$/, `/${dbName}`);
}

// ---------------------------------------------------------------------------
// Reachability — top-level await before describe() blocks
// ---------------------------------------------------------------------------

let _pgReachable: boolean | null = null;

export async function checkPgReachable(): Promise<boolean> {
  if (_pgReachable !== null) return _pgReachable;
  const client = new pg.Client({ connectionString: getAdminConnString() });
  try {
    await client.connect();
    await client.end();
    _pgReachable = true;
  } catch {
    _pgReachable = false;
  }
  // Release gate (#26): PG-backed suites are normally skip-if-unreachable so the
  // unit suite stays runnable anywhere. But a RELEASE must exercise the whole
  // booted flow for every case — a silent skip there would let an integration
  // regression ship green (exactly how the 0.3.2 brick happened). When
  // VIVA_REQUIRE_PG is set (the release scripts set it), an unreachable Postgres
  // is a hard failure, not a skip.
  if (!_pgReachable && process.env['VIVA_REQUIRE_PG']) {
    throw new Error(
      'VIVA_REQUIRE_PG is set but Postgres is unreachable — the release gate requires a live ' +
        'database so the full booted cancel/settle/webhook flow runs. Start Postgres ' +
        '(DATABASE_URL or postgres@localhost:5432) and re-run.',
    );
  }
  return _pgReachable;
}

// ---------------------------------------------------------------------------
// Database lifecycle
// ---------------------------------------------------------------------------

export async function createTestDatabase(): Promise<void> {
  const admin = new pg.Client({ connectionString: getAdminConnString() });
  await admin.connect();
  try {
    const dbName = getTestDbName();
    await admin.query(`DROP DATABASE IF EXISTS "${dbName}"`);
    await admin.query(`CREATE DATABASE "${dbName}"`);
  } finally {
    await admin.end();
  }
}

export async function dropTestDatabase(): Promise<void> {
  const admin = new pg.Client({ connectionString: getAdminConnString() });
  await admin.connect();
  try {
    const dbName = getTestDbName();
    await admin.query(
      `SELECT pg_terminate_backend(pg_stat_activity.pid)
       FROM pg_stat_activity
       WHERE pg_stat_activity.datname = $1 AND pid <> pg_backend_pid()`,
      [dbName],
    );
    await admin.query(`DROP DATABASE IF EXISTS "${dbName}"`);
  } finally {
    await admin.end();
  }
}

// ---------------------------------------------------------------------------
// Migration runner — raw SQL mirrors migration file exactly
// ---------------------------------------------------------------------------

export async function runMigrationsUp(connString: string): Promise<void> {
  const client = new pg.Client({ connectionString: connString });
  await client.connect();
  try {
    // Ensure gen_random_uuid() is available (pgcrypto on PG < 13, built-in on PG ≥ 13)
    await client.query(`CREATE EXTENSION IF NOT EXISTS pgcrypto`);

    // viva_transaction
    await client.query(`
      CREATE TABLE IF NOT EXISTS "viva_transaction" (
        "id"                  uuid                     NOT NULL DEFAULT gen_random_uuid(),
        "channel_id"          integer                  NOT NULL,
        "payment_id"          integer                  NOT NULL,
        "viva_order_code"     character varying        DEFAULT NULL,
        "viva_transaction_id" character varying        DEFAULT NULL,
        "status"              character varying        NOT NULL,
        "amount_minor"        bigint                   NOT NULL,
        "currency_code"       character varying(3)     NOT NULL,
        "isv_amount_minor"    bigint                   NOT NULL DEFAULT 0,
        "metadata"            jsonb                    NOT NULL DEFAULT '{}',
        "created_at"          timestamp with time zone NOT NULL DEFAULT now(),
        "updated_at"          timestamp with time zone NOT NULL DEFAULT now(),
        CONSTRAINT "PK_viva_transaction" PRIMARY KEY ("id")
      )
    `);

    await client.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS "idx_viva_transaction_channel_payment"
        ON "viva_transaction" ("channel_id", "payment_id")
    `);

    await client.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS "idx_viva_transaction_order_code"
        ON "viva_transaction" ("viva_order_code")
        WHERE "viva_order_code" IS NOT NULL
    `);

    await client.query(`
      CREATE INDEX IF NOT EXISTS "idx_viva_transaction_channel_order_code"
        ON "viva_transaction" ("channel_id", "viva_order_code")
    `);

    await client.query(`
      CREATE INDEX IF NOT EXISTS "idx_viva_transaction_transaction_id"
        ON "viva_transaction" ("viva_transaction_id")
    `);

    // viva_webhook_event
    await client.query(`
      CREATE TABLE IF NOT EXISTS "viva_webhook_event" (
        "message_id"      uuid                     NOT NULL,
        "event_type_id"   integer                  NOT NULL,
        "merchant_id"     uuid                     DEFAULT NULL,
        "transaction_id"  character varying        DEFAULT NULL,
        "account_id"      character varying        DEFAULT NULL,
        "correlation_id"  character varying        DEFAULT NULL,
        "retry_count"     integer                  NOT NULL DEFAULT 0,
        "payload"         jsonb                    NOT NULL,
        "received_at"     timestamp with time zone NOT NULL DEFAULT now(),
        "processed_at"    timestamp with time zone DEFAULT NULL,
        "error"           text                     DEFAULT NULL,
        CONSTRAINT "PK_viva_webhook_event" PRIMARY KEY ("message_id")
      )
    `);

    await client.query(`
      CREATE INDEX IF NOT EXISTS "idx_viva_webhook_event_merchant_type"
        ON "viva_webhook_event" ("merchant_id", "event_type_id")
    `);

    await client.query(`
      CREATE INDEX IF NOT EXISTS "idx_viva_webhook_event_pending_received"
        ON "viva_webhook_event" ("received_at")
        WHERE "processed_at" IS NULL
    `);
  } finally {
    await client.end();
  }
}
