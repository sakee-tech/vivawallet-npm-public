/**
 * test/entities/viva-webhook-event.test.ts — Integration tests for viva_webhook_event table.
 *
 * Tests INSERT-OR-IGNORE dedupe behaviour, composite index existence, and
 * partial index existence for the pending-event scan.
 *
 * Uses the same throwaway Postgres DB created by the viva-transaction test
 * (same pid, same db name) — both test files share the DB lifecycle via
 * beforeAll/afterAll. Vitest runs test files in separate worker threads by
 * default, so each file manages its own connection.
 */

import { describe, it, beforeAll, afterAll, expect } from 'vitest';
import pg from 'pg';
import {
  checkPgReachable,
  createTestDatabase,
  dropTestDatabase,
  getTestConnString,
  runMigrationsUp,
} from '../helpers/db.js';

// Top-level await — must resolve before describe() is evaluated.
const pgReachable = await checkPgReachable();

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function uuid(): string {
  // Simple RFC-4122 UUIDv4 using crypto (Node ≥ 15)
  return crypto.randomUUID();
}

async function insertEvent(
  client: pg.Client,
  opts: {
    messageId?: string;
    eventTypeId?: number;
    merchantId?: string | null;
    transactionId?: string | null;
    payload?: Record<string, unknown>;
  } = {},
): Promise<void> {
  const {
    messageId = uuid(),
    eventTypeId = 1796,
    merchantId = null,
    transactionId = null,
    payload = { Amount: 1999 },
  } = opts;

  await client.query(
    `INSERT INTO viva_webhook_event
       (message_id, event_type_id, merchant_id, transaction_id, payload)
     VALUES ($1, $2, $3, $4, $5)`,
    [messageId, eventTypeId, merchantId, transactionId, JSON.stringify(payload)],
  );
}

async function insertEventOrIgnore(
  client: pg.Client,
  messageId: string,
  eventTypeId = 1796,
): Promise<{ rowsAffected: number }> {
  const res = await client.query(
    `INSERT INTO viva_webhook_event (message_id, event_type_id, payload)
     VALUES ($1, $2, $3)
     ON CONFLICT (message_id) DO NOTHING`,
    [messageId, eventTypeId, JSON.stringify({})],
  );
  return { rowsAffected: res.rowCount ?? 0 };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe.skipIf(!pgReachable)(
  'viva_webhook_event entity (integration)',
  () => {
    let client: pg.Client;

    beforeAll(async () => {
      // This file may run in a separate Vitest worker; create the DB fresh.
      // If it already exists (e.g. from the transaction test worker), DROP+CREATE
      // ensures a clean state. The db helper always does DROP IF EXISTS first.
      await createTestDatabase();
      const connStr = getTestConnString();
      await runMigrationsUp(connStr);
      client = new pg.Client({ connectionString: connStr });
      await client.connect();
    });

    afterAll(async () => {
      await client.end();
      await dropTestDatabase();
    });

    // -----------------------------------------------------------------------
    // Persist and round-trip
    // -----------------------------------------------------------------------

    it('persists a webhook event row with all nullable columns', async () => {
      const msgId = uuid();
      await insertEvent(client, {
        messageId: msgId,
        eventTypeId: 1796,
        merchantId: '11111111-1111-1111-1111-111111111111',
        transactionId: 'txn-abc',
        payload: { Amount: 1234, TransactionId: 'txn-abc' },
      });

      const res = await client.query<{
        message_id: string;
        event_type_id: number;
        merchant_id: string;
        transaction_id: string;
        retry_count: number;
        received_at: Date;
        processed_at: Date | null;
        error: string | null;
      }>(`SELECT * FROM viva_webhook_event WHERE message_id = $1`, [msgId]);

      const row = res.rows[0]!;
      expect(row.message_id).toBe(msgId);
      expect(row.event_type_id).toBe(1796);
      expect(row.merchant_id).toBe('11111111-1111-1111-1111-111111111111');
      expect(row.transaction_id).toBe('txn-abc');
      expect(row.retry_count).toBe(0);
      expect(row.received_at).toBeInstanceOf(Date);
      expect(row.processed_at).toBeNull();
      expect(row.error).toBeNull();
    });

    // -----------------------------------------------------------------------
    // INSERT-OR-IGNORE (dedupe) behaviour
    // -----------------------------------------------------------------------

    it('INSERT-OR-IGNORE: first insert returns rowsAffected=1', async () => {
      const msgId = uuid();
      const { rowsAffected } = await insertEventOrIgnore(client, msgId);
      expect(rowsAffected).toBe(1);
    });

    it('INSERT-OR-IGNORE: duplicate messageId returns rowsAffected=0 (no error)', async () => {
      const msgId = uuid();
      await insertEventOrIgnore(client, msgId, 1796);
      const { rowsAffected } = await insertEventOrIgnore(client, msgId, 1796);
      expect(rowsAffected).toBe(0);
    });

    it('INSERT-OR-IGNORE: original row is unchanged after duplicate attempt', async () => {
      const msgId = uuid();
      await client.query(
        `INSERT INTO viva_webhook_event (message_id, event_type_id, payload, retry_count)
         VALUES ($1, $2, $3, $4)`,
        [msgId, 1796, JSON.stringify({ original: true }), 0],
      );
      // Attempt to insert with different data — should be ignored
      await client.query(
        `INSERT INTO viva_webhook_event (message_id, event_type_id, payload, retry_count)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (message_id) DO NOTHING`,
        [msgId, 9999, JSON.stringify({ overwrite: true }), 5],
      );

      const res = await client.query<{ event_type_id: number; retry_count: number }>(
        `SELECT event_type_id, retry_count FROM viva_webhook_event WHERE message_id = $1`,
        [msgId],
      );
      expect(res.rows[0]!.event_type_id).toBe(1796);
      expect(res.rows[0]!.retry_count).toBe(0);
    });

    // -----------------------------------------------------------------------
    // Composite index on (merchant_id, event_type_id) exists
    // -----------------------------------------------------------------------

    it('composite index idx_viva_webhook_event_merchant_type exists in pg_indexes', async () => {
      const res = await client.query<{ indexname: string }>(
        `SELECT indexname FROM pg_indexes
         WHERE tablename = 'viva_webhook_event'
           AND indexname = 'idx_viva_webhook_event_merchant_type'`,
      );
      expect(res.rows.length).toBe(1);
    });

    // -----------------------------------------------------------------------
    // Partial index on received_at WHERE processed_at IS NULL exists
    // -----------------------------------------------------------------------

    it('partial index idx_viva_webhook_event_pending_received exists in pg_indexes', async () => {
      const res = await client.query<{ indexname: string; indexdef: string }>(
        `SELECT indexname, indexdef FROM pg_indexes
         WHERE tablename = 'viva_webhook_event'
           AND indexname = 'idx_viva_webhook_event_pending_received'`,
      );
      expect(res.rows.length).toBe(1);
      // Verify the WHERE clause is present in the index definition
      expect(res.rows[0]!.indexdef.toLowerCase()).toContain('where');
      expect(res.rows[0]!.indexdef.toLowerCase()).toContain('processed_at');
    });

    // -----------------------------------------------------------------------
    // processed_at can be set (simulates job completion)
    // -----------------------------------------------------------------------

    it('processed_at can be updated from NULL to a timestamp', async () => {
      const msgId = uuid();
      await insertEvent(client, { messageId: msgId });

      await client.query(
        `UPDATE viva_webhook_event SET processed_at = now() WHERE message_id = $1`,
        [msgId],
      );

      const res = await client.query<{ processed_at: Date | null }>(
        `SELECT processed_at FROM viva_webhook_event WHERE message_id = $1`,
        [msgId],
      );
      expect(res.rows[0]!.processed_at).toBeInstanceOf(Date);
    });
  },
);

describe.skipIf(pgReachable)(
  'viva_webhook_event entity (skipped — Postgres not reachable)',
  () => {
    it('skipped', () => {
      console.warn('Postgres not reachable — skipping viva_webhook_event integration tests');
    });
  },
);
