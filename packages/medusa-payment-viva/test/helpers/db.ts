/**
 * test/helpers/db.ts — Postgres test database lifecycle helpers.
 *
 * Creates a throwaway Postgres database for integration tests, runs migrations,
 * and drops the database on teardown. Each test run gets a uniquely named DB
 * to avoid contention between parallel runs.
 *
 * Connection: uses DATABASE_URL or falls back to
 * `postgresql://${USER}@localhost:5432/postgres`.
 *
 * Skip integration tests if Postgres is unreachable by checking the exported
 * `pgReachable` promise before each integration test suite.
 */

import pg from 'pg';

// ---------------------------------------------------------------------------
// Connection config
// ---------------------------------------------------------------------------

function getAdminConnString(): string {
  return process.env['DATABASE_URL'] ??
    `postgresql://${process.env['USER'] ?? 'postgres'}@localhost:5432/postgres`;
}

export function getTestDbName(): string {
  return `viva_test_s6_${process.pid}`;
}

export function getTestConnString(): string {
  const admin = getAdminConnString();
  // Replace the database name in the connection string
  const dbName = getTestDbName();
  return admin.replace(/\/[^/]+$/, `/${dbName}`);
}

// ---------------------------------------------------------------------------
// Reachability check
// ---------------------------------------------------------------------------

let _pgReachable: boolean | null = null;

export async function checkPgReachable(): Promise<boolean> {
  if (_pgReachable !== null) return _pgReachable;
  const client = new pg.Client({ connectionString: getAdminConnString() });
  try {
    await client.connect();
    await client.end();
    _pgReachable = true;
    return true;
  } catch {
    _pgReachable = false;
    return false;
  }
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
    // Terminate existing connections before drop
    await admin.query(`
      SELECT pg_terminate_backend(pg_stat_activity.pid)
      FROM pg_stat_activity
      WHERE pg_stat_activity.datname = $1 AND pid <> pg_backend_pid()
    `, [dbName]);
    await admin.query(`DROP DATABASE IF EXISTS "${dbName}"`);
  } finally {
    await admin.end();
  }
}

// ---------------------------------------------------------------------------
// Migration runner (raw SQL)
// ---------------------------------------------------------------------------

/**
 * Runs the SQL from both migration files against the test database.
 * We execute the SQL directly via pg rather than running Mikro-ORM's migration
 * runner to avoid needing a full Medusa setup in tests.
 */
export async function runMigrationsUp(connString: string): Promise<void> {
  const client = new pg.Client({ connectionString: connString });
  await client.connect();
  try {
    // Require gen_random_uuid()
    await client.query(`CREATE EXTENSION IF NOT EXISTS pgcrypto`);

    // Migration 1: init tables
    await client.query(`
      CREATE TABLE IF NOT EXISTS viva_tenant_merchant (
        tenant_id             text        PRIMARY KEY,
        connected_account_id  uuid        NOT NULL,
        viva_merchant_id      uuid        NOT NULL,
        verification_status   text        NOT NULL DEFAULT 'pending',
        created_at            timestamptz NOT NULL DEFAULT now(),
        updated_at            timestamptz NOT NULL DEFAULT now()
      )
    `);
    await client.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS viva_tenant_merchant_viva_merchant_id_uniq
        ON viva_tenant_merchant (viva_merchant_id)
    `);
    await client.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS viva_tenant_merchant_connected_account_id_uniq
        ON viva_tenant_merchant (connected_account_id)
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS viva_transaction (
        viva_transaction_id   uuid        PRIMARY KEY,
        viva_order_code       bigint,
        medusa_payment_id     text        NOT NULL,
        viva_merchant_id      uuid        NOT NULL,
        status                text        NOT NULL CHECK (status IN (
          'initiated','authorized','captured','refunded','cancelled','failed','disputed'
        )),
        claim_substate        text,
        amount_minor          bigint      NOT NULL,
        refunded_amount_minor bigint      NOT NULL DEFAULT 0,
        currency_code         text        NOT NULL,
        idempotency_key       text        NOT NULL,
        raw_payload           jsonb,
        created_at            timestamptz NOT NULL DEFAULT now(),
        updated_at            timestamptz NOT NULL DEFAULT now()
      )
    `);
    await client.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS viva_transaction_idempotency_key_uniq
        ON viva_transaction (idempotency_key)
    `);
    await client.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS viva_transaction_viva_order_code_uniq
        ON viva_transaction (viva_order_code)
        WHERE viva_order_code IS NOT NULL
    `);
    await client.query(`
      CREATE INDEX IF NOT EXISTS viva_transaction_medusa_payment_id_idx
        ON viva_transaction (medusa_payment_id)
    `);
    await client.query(`
      CREATE INDEX IF NOT EXISTS viva_transaction_merchant_created_idx
        ON viva_transaction (viva_merchant_id, created_at)
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS viva_webhook_event (
        viva_webhook_event_id uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
        transaction_id        uuid,
        event_type_id         int         NOT NULL,
        message_id            uuid        NOT NULL,
        viva_merchant_id      uuid,
        connected_account_id  uuid,
        processed_at          timestamptz,
        raw_payload           jsonb       NOT NULL,
        received_at           timestamptz NOT NULL DEFAULT now()
      )
    `);
    await client.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS viva_webhook_event_txn_type_uniq
        ON viva_webhook_event (transaction_id, event_type_id)
        WHERE transaction_id IS NOT NULL
    `);
    await client.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS viva_webhook_event_message_id_uniq
        ON viva_webhook_event (message_id)
    `);

    // Migration 3: retry_count column (A6)
    await client.query(`
      ALTER TABLE viva_webhook_event
        ADD COLUMN IF NOT EXISTS retry_count int NOT NULL DEFAULT 0
    `);
    await client.query(`
      CREATE INDEX IF NOT EXISTS viva_webhook_event_unresolved_retry_idx
        ON viva_webhook_event (received_at, retry_count)
        WHERE processed_at IS NULL
    `);

    // Migration 4: viva_webhook_event.error column + viva_transaction.viva_merchant_id nullable
    await client.query(`
      ALTER TABLE viva_webhook_event
        ADD COLUMN IF NOT EXISTS error text
    `);
    await client.query(`
      ALTER TABLE viva_transaction
        ALTER COLUMN viva_merchant_id DROP NOT NULL
    `);
  } finally {
    await client.end();
  }
}

export function getTestDbName8(suffix?: string): string {
  return `viva_test_s8_${process.pid}${suffix ? `_${suffix}` : ''}`;
}

export function getTestConnString8(suffix?: string): string {
  const admin = (process.env['DATABASE_URL'] ??
    `postgresql://${process.env['USER'] ?? 'postgres'}@localhost:5432/postgres`);
  return admin.replace(/\/[^/]+$/, `/${getTestDbName8(suffix)}`);
}

export async function createTestDatabase8(suffix?: string): Promise<void> {
  const adminCs = process.env['DATABASE_URL'] ??
    `postgresql://${process.env['USER'] ?? 'postgres'}@localhost:5432/postgres`;
  const admin = new pg.Client({ connectionString: adminCs });
  await admin.connect();
  try {
    const dbName = getTestDbName8(suffix);
    await admin.query(`DROP DATABASE IF EXISTS "${dbName}"`);
    await admin.query(`CREATE DATABASE "${dbName}"`);
  } finally {
    await admin.end();
  }
}

export async function dropTestDatabase8(suffix?: string): Promise<void> {
  const adminCs = process.env['DATABASE_URL'] ??
    `postgresql://${process.env['USER'] ?? 'postgres'}@localhost:5432/postgres`;
  const admin = new pg.Client({ connectionString: adminCs });
  await admin.connect();
  try {
    const dbName = getTestDbName8(suffix);
    await admin.query(`
      SELECT pg_terminate_backend(pg_stat_activity.pid)
      FROM pg_stat_activity
      WHERE pg_stat_activity.datname = $1 AND pid <> pg_backend_pid()
    `, [dbName]);
    await admin.query(`DROP DATABASE IF EXISTS "${dbName}"`);
  } finally {
    await admin.end();
  }
}

export async function truncateTables(connString: string): Promise<void> {
  const client = new pg.Client({ connectionString: connString });
  await client.connect();
  try {
    await client.query(`TRUNCATE viva_transaction, viva_webhook_event, viva_tenant_merchant CASCADE`);
  } finally {
    await client.end();
  }
}

export async function seedTenant(
  connString: string,
  opts: {
    tenantId: string;
    connectedAccountId: string;
    vivaMerchantId: string;
  },
): Promise<void> {
  const client = new pg.Client({ connectionString: connString });
  await client.connect();
  try {
    await client.query(
      `INSERT INTO viva_tenant_merchant (tenant_id, connected_account_id, viva_merchant_id)
       VALUES ($1, $2, $3)
       ON CONFLICT DO NOTHING`,
      [opts.tenantId, opts.connectedAccountId, opts.vivaMerchantId],
    );
  } finally {
    await client.end();
  }
}
