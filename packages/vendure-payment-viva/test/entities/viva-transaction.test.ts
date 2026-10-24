/**
 * test/entities/viva-transaction.test.ts — Integration tests for viva_transaction table.
 *
 * Boots a throwaway Postgres DB, runs the V3 migration SQL, and exercises the
 * constraints declared in viva-transaction.entity.ts.
 *
 * Skips gracefully if Postgres is unreachable (CI without a DB service).
 * pgReachable is top-level awaited BEFORE describe() per decision #7 in the
 * design doc — vitest collects test files before running beforeAll, so a skip
 * inside beforeAll would be too late.
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

function makeTransaction(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    channel_id: 1,
    payment_id: 100,
    viva_order_code: null,
    viva_transaction_id: null,
    status: 'pending',
    amount_minor: 1999,
    currency_code: 'GBP',
    isv_amount_minor: 0,
    metadata: {},
    ...overrides,
  };
}

async function insertTransaction(
  client: pg.Client,
  tx: Record<string, unknown>,
): Promise<string> {
  const {
    channel_id,
    payment_id,
    viva_order_code,
    viva_transaction_id,
    status,
    amount_minor,
    currency_code,
    isv_amount_minor,
    metadata,
  } = tx as {
    channel_id: number;
    payment_id: number;
    viva_order_code: string | null;
    viva_transaction_id: string | null;
    status: string;
    amount_minor: number;
    currency_code: string;
    isv_amount_minor: number;
    metadata: Record<string, unknown>;
  };

  const res = await client.query<{ id: string }>(
    `INSERT INTO viva_transaction
       (channel_id, payment_id, viva_order_code, viva_transaction_id, status,
        amount_minor, currency_code, isv_amount_minor, metadata)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
     RETURNING id`,
    [
      channel_id,
      payment_id,
      viva_order_code,
      viva_transaction_id,
      status,
      amount_minor,
      currency_code,
      isv_amount_minor,
      JSON.stringify(metadata),
    ],
  );
  return res.rows[0]!.id;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe.skipIf(!pgReachable)(
  'viva_transaction entity (integration)',
  () => {
    let client: pg.Client;

    beforeAll(async () => {
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

    it('persists a row and round-trips all columns', async () => {
      const id = await insertTransaction(client, makeTransaction({
        channel_id: 1,
        payment_id: 200,
        viva_order_code: '987654321',
        viva_transaction_id: 'txn-abc',
        status: 'pending',
        amount_minor: 4999,
        currency_code: 'GBP',
        isv_amount_minor: 50,
        metadata: { redirectUrl: 'https://example.com/pay' },
      }));

      const res = await client.query<{
        id: string;
        channel_id: number;
        payment_id: number;
        viva_order_code: string;
        viva_transaction_id: string;
        status: string;
        amount_minor: string; // bigint comes back as string
        currency_code: string;
        isv_amount_minor: string;
        metadata: Record<string, unknown>;
        created_at: Date;
        updated_at: Date;
      }>(`SELECT * FROM viva_transaction WHERE id = $1`, [id]);

      const row = res.rows[0]!;
      expect(row.channel_id).toBe(1);
      expect(row.payment_id).toBe(200);
      expect(row.viva_order_code).toBe('987654321');
      expect(row.viva_transaction_id).toBe('txn-abc');
      expect(row.status).toBe('pending');
      // bigint columns come back as strings from pg driver
      expect(row.amount_minor).toBe('4999');
      expect(row.isv_amount_minor).toBe('50');
      expect(row.currency_code).toBe('GBP');
      expect(row.metadata).toMatchObject({ redirectUrl: 'https://example.com/pay' });
      expect(row.created_at).toBeInstanceOf(Date);
      expect(row.updated_at).toBeInstanceOf(Date);
    });

    // -----------------------------------------------------------------------
    // All valid status values accepted
    // -----------------------------------------------------------------------

    it('accepts all valid status enum values', async () => {
      const statuses = [
        'pending',
        'authorized',
        'captured',
        'refunded',
        'partially_refunded',
        'failed',
        'cancelled',
      ] as const;

      for (const [i, status] of statuses.entries()) {
        const id = await insertTransaction(
          client,
          makeTransaction({ channel_id: 99, payment_id: 300 + i, status }),
        );
        const res = await client.query<{ status: string }>(
          `SELECT status FROM viva_transaction WHERE id = $1`,
          [id],
        );
        expect(res.rows[0]!.status).toBe(status);
      }
    });

    // -----------------------------------------------------------------------
    // (channelId, paymentId) composite unique constraint
    // -----------------------------------------------------------------------

    it('enforces composite unique on (channel_id, payment_id)', async () => {
      await insertTransaction(client, makeTransaction({ channel_id: 2, payment_id: 400 }));

      await expect(
        insertTransaction(client, makeTransaction({ channel_id: 2, payment_id: 400 })),
      ).rejects.toThrow(/unique/i);
    });

    it('allows same payment_id on different channel_id', async () => {
      await insertTransaction(client, makeTransaction({ channel_id: 3, payment_id: 500 }));
      // Different channel — should succeed
      const id = await insertTransaction(
        client,
        makeTransaction({ channel_id: 4, payment_id: 500 }),
      );
      expect(id).toBeTruthy();
    });

    // -----------------------------------------------------------------------
    // Partial unique on viva_order_code WHERE NOT NULL
    // -----------------------------------------------------------------------

    it('rejects duplicate non-NULL viva_order_code', async () => {
      await insertTransaction(
        client,
        makeTransaction({ channel_id: 5, payment_id: 600, viva_order_code: 'ORDER-DUP' }),
      );

      await expect(
        insertTransaction(
          client,
          makeTransaction({ channel_id: 5, payment_id: 601, viva_order_code: 'ORDER-DUP' }),
        ),
      ).rejects.toThrow(/unique/i);
    });

    it('allows multiple NULL viva_order_code values (partial unique)', async () => {
      // Both rows have viva_order_code = NULL — partial index should allow it.
      const id1 = await insertTransaction(
        client,
        makeTransaction({ channel_id: 6, payment_id: 700, viva_order_code: null }),
      );
      const id2 = await insertTransaction(
        client,
        makeTransaction({ channel_id: 6, payment_id: 701, viva_order_code: null }),
      );
      expect(id1).toBeTruthy();
      expect(id2).toBeTruthy();
    });
  },
);

describe.skipIf(pgReachable)(
  'viva_transaction entity (skipped — Postgres not reachable)',
  () => {
    it('skipped', () => {
      console.warn('Postgres not reachable — skipping viva_transaction integration tests');
    });
  },
);
