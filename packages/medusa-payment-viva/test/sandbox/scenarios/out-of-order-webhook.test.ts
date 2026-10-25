/**
 * out-of-order-webhook.test.ts — Full e2e: 1798 (failed) arrives first; 1796 (captured) arrives late.
 *
 * Exercises the lattice rejection path at the DB level:
 *   1. Seed a viva_transaction at status='initiated'.
 *   2. Inject 1798 (failed) webhook, process it (MockAgent returns StatusId=E).
 *      Assert: viva_transaction.status='failed'; processed_at IS NOT NULL.
 *   3. Inject 1796 (captured) webhook (out of order), process it (MockAgent returns StatusId=F).
 *      Assert: lattice rejects TERMINAL/BACKWARD;
 *              viva_transaction.status stays 'failed' (unchanged);
 *              viva_webhook_event.processed_at IS NOT NULL on the second row.
 *
 * Skipped when Postgres is not reachable.
 *
 * @see Plan P14 (monotonic status lattice — terminal states never regress)
 * @see Plan P17 (StatusId letter mapping)
 * @see references/viva-docs/md/webhooks-for-payments.txt:248 (A3 retrieve-before-update)
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import pg from 'pg';
import { v4 as uuidv4 } from 'uuid';
// MockAgent and undiciFetch not needed (using vi.fn mock for isvPayments)
import {
  checkPgReachable,
  runMigrationsUp,
  seedTenant,
} from '../../helpers/db.js';
import { processWebhookEvent } from '../../../src/workflows/process-webhook-event.js';
import type { ProcessWebhookInput, ProcessWebhookContext } from '../../../src/workflows/process-webhook-event.js';
import { IsvPayments } from '@sakeetech/viva-payments-core/isv';
import type { VivaWebhookEnvelope } from '@sakeetech/viva-payments-core/types';
import type { TransactionId, MinorUnits } from '@sakeetech/viva-payments-core/types';

// Import fixtures using relative path to core test sandbox
import { loadFixture } from '../../../../viva-payments-core/test/sandbox/fixtures-loader.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const TEST_TENANT_ID = 'tenant-s11-ooow-001';
const TEST_CONNECTED_ACCOUNT_ID = 'eeeeeeee-ffff-0000-1111-aaaaaaaaaa99';
const TEST_VIVA_MERCHANT_ID = 'cccccccc-dddd-eeee-ffff-000000000001';
const TEST_MEDUSA_PAYMENT_ID = 'pay_s11_ooow_001';
const TEST_ORDER_CODE = '1234567890123456';
// 1798 fixture uses transactionId aaaaaaaa-1111-2222-3333-dddddddddddd
const TEST_TRANSACTION_ID_1798 = 'aaaaaaaa-1111-2222-3333-dddddddddddd' as TransactionId;
// 1796 out-of-order fixture uses the same transactionId
const TEST_TRANSACTION_ID_1796_OOO = 'aaaaaaaa-1111-2222-3333-dddddddddddd' as TransactionId;
const AMOUNT_MINOR = 9999n as MinorUnits;

// ---------------------------------------------------------------------------
// DB helpers
// ---------------------------------------------------------------------------

function getAdminConnString(): string {
  return process.env['DATABASE_URL'] ??
    `postgresql://${process.env['USER'] ?? 'postgres'}@localhost:5432/postgres`;
}

function getS11OoowDbName(): string {
  return `viva_test_s11_ooow_${process.pid}`;
}

function getS11OoowConnString(): string {
  return getAdminConnString().replace(/\/[^/]+$/, `/${getS11OoowDbName()}`);
}

async function createS11OoowDatabase(): Promise<void> {
  const admin = new pg.Client({ connectionString: getAdminConnString() });
  await admin.connect();
  try {
    const dbName = getS11OoowDbName();
    await admin.query(`DROP DATABASE IF EXISTS "${dbName}"`);
    await admin.query(`CREATE DATABASE "${dbName}"`);
  } finally {
    await admin.end();
  }
}

async function dropS11OoowDatabase(): Promise<void> {
  const admin = new pg.Client({ connectionString: getAdminConnString() });
  await admin.connect();
  try {
    const dbName = getS11OoowDbName();
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
// DB setup
// ---------------------------------------------------------------------------

const pgReachable = await checkPgReachable();
let connString = '';
let pool: pg.Pool;

beforeAll(async () => {
  if (!pgReachable) {
    console.warn('[s11/out-of-order-webhook] Postgres not reachable — integration tests will be skipped.');
    return;
  }
  await createS11OoowDatabase();
  connString = getS11OoowConnString();
  await runMigrationsUp(connString);
  pool = new pg.Pool({ connectionString: connString, max: 5 });
  await seedTenant(connString, {
    tenantId: TEST_TENANT_ID,
    connectedAccountId: TEST_CONNECTED_ACCOUNT_ID,
    vivaMerchantId: TEST_VIVA_MERCHANT_ID,
  });
});

afterAll(async () => {
  if (pool) await pool.end().catch(() => undefined);
  if (pgReachable) await dropS11OoowDatabase();
});

beforeEach(async () => {
  if (!pgReachable) return;
  await pool.query(`TRUNCATE viva_transaction, viva_webhook_event CASCADE`);
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const noop = { info: () => undefined, warn: () => undefined, error: () => undefined };

async function insertInitiatedTransaction(): Promise<string> {
  const txId = uuidv4();
  await pool.query(
    `INSERT INTO viva_transaction
       (viva_transaction_id, viva_order_code, medusa_payment_id, viva_merchant_id,
        status, amount_minor, refunded_amount_minor, currency_code, idempotency_key,
        raw_payload, created_at, updated_at)
     VALUES ($1, $2, $3, $4, 'initiated', $5, 0, '978', $6, NULL, now(), now())`,
    [txId, TEST_ORDER_CODE, TEST_MEDUSA_PAYMENT_ID, TEST_VIVA_MERCHANT_ID, AMOUNT_MINOR.toString(), TEST_MEDUSA_PAYMENT_ID],
  );
  return txId;
}

async function insertWebhookEvent(
  envelope: VivaWebhookEnvelope,
  txId: string | null = null,
): Promise<string> {
  const eventId = uuidv4();
  const messageId = (envelope as { MessageId: string }).MessageId ?? uuidv4();
  const eventTypeId = envelope.EventTypeId;

  await pool.query(
    `INSERT INTO viva_webhook_event
       (viva_webhook_event_id, event_type_id, message_id, viva_merchant_id,
        transaction_id, raw_payload, received_at)
     VALUES ($1, $2, $3, $4, $5, $6, now())`,
    [
      eventId,
      eventTypeId,
      messageId,
      TEST_VIVA_MERCHANT_ID,
      txId,
      JSON.stringify(envelope),
    ],
  );
  return eventId;
}

// ---------------------------------------------------------------------------
// Out-of-order test
// ---------------------------------------------------------------------------

describe('sandbox/out-of-order-webhook (medusa, real Postgres, MockAgent)', () => {
  it.skipIf(!pgReachable)(
    '1798 (failed) processed first; then 1796 (captured) arrives late — lattice rejects, status stays failed',
    async () => {
      // ---- Step 1: Insert transaction at status='initiated' ----
      const txId = await insertInitiatedTransaction();

      {
        const r = await pool.query(
          `SELECT status FROM viva_transaction WHERE viva_transaction_id = $1`,
          [txId],
        );
        expect(r.rows[0].status).toBe('initiated');
      }

      // ---- Step 2a: Inject 1798 (failed) webhook ----
      const envelope1798 = loadFixture<VivaWebhookEnvelope>('webhooks', 'envelope-1798-failed');
      const eventId1798 = await insertWebhookEvent(envelope1798, txId);

      // Mock IsvPayments returning StatusId=E (failed).
      // Use vi.fn mock to avoid BigInt serialization issue in processWebhookEvent.ts.
      const errorFixture = loadFixture<{ statusId: string }>('isv', 'retrieve-transaction-error');
      expect(errorFixture.statusId).toBe('E');

      const mockIsvPayments1 = {
        retrieveTransaction: vi.fn(async () => ({
          transactionId: TEST_TRANSACTION_ID_1798,
          orderCode: 1234567890123456 as unknown as import('viva-payments-core/types').OrderCode,
          statusId: 'E',
          amount: Number(AMOUNT_MINOR) as unknown as import('viva-payments-core/types').MinorUnits,
          currencyCode: '978' as import('viva-payments-core/types').CurrencyCode,
          merchantId: TEST_VIVA_MERCHANT_ID,
          parentId: null,
          insDate: new Date().toISOString(),
          transactionTypeId: 5,
        })),
        createOrder: vi.fn(),
        refundPayment: vi.fn(),
        cancelOrder: vi.fn(),
      } as unknown as IsvPayments;

      const input1798: ProcessWebhookInput = {
        eventId: eventId1798,
        eventTypeId: 1798,
        envelope: envelope1798,
        tenantId: TEST_TENANT_ID,
      };
      const ctx: ProcessWebhookContext = { pool, isvPayments: mockIsvPayments1, logger: noop };

      const result1798 = await processWebhookEvent(input1798, ctx);
      expect(result1798.applied).toBe(true);

      // Assert: status='failed'
      {
        const r = await pool.query(
          `SELECT status FROM viva_transaction WHERE viva_transaction_id = $1`,
          [txId],
        );
        expect(r.rows[0].status).toBe('failed');
      }

      // Assert: processed_at IS NOT NULL on 1798 event
      {
        const r = await pool.query(
          `SELECT processed_at FROM viva_webhook_event WHERE viva_webhook_event_id = $1`,
          [eventId1798],
        );
        expect(r.rows[0].processed_at).not.toBeNull();
      }

      // ---- Step 2b: Inject 1796 (captured) out-of-order ----
      const envelope1796OoO = loadFixture<VivaWebhookEnvelope>('webhooks', 'envelope-1796-out-of-order');
      const eventId1796OoO = await insertWebhookEvent(envelope1796OoO, txId);

      // Mock IsvPayments returning StatusId=F (captured) — Viva says it's captured,
      // but our local lattice has already transitioned to 'failed' (terminal).
      const finishedFixture = loadFixture<{ statusId: string }>('isv', 'retrieve-transaction-finished');
      expect(finishedFixture.statusId).toBe('F');

      const mockIsvPayments2 = {
        retrieveTransaction: vi.fn(async () => ({
          transactionId: TEST_TRANSACTION_ID_1796_OOO,
          orderCode: 1234567890123456 as unknown as import('viva-payments-core/types').OrderCode,
          statusId: 'F',
          amount: Number(AMOUNT_MINOR) as unknown as import('viva-payments-core/types').MinorUnits,
          currencyCode: '978' as import('viva-payments-core/types').CurrencyCode,
          merchantId: TEST_VIVA_MERCHANT_ID,
          parentId: null,
          insDate: new Date().toISOString(),
          transactionTypeId: 5,
        })),
        createOrder: vi.fn(),
        refundPayment: vi.fn(),
        cancelOrder: vi.fn(),
      } as unknown as IsvPayments;

      const input1796OoO: ProcessWebhookInput = {
        eventId: eventId1796OoO,
        eventTypeId: 1796,
        envelope: envelope1796OoO,
        tenantId: TEST_TENANT_ID,
      };
      const ctx2: ProcessWebhookContext = { pool, isvPayments: mockIsvPayments2, logger: noop };

      const result1796OoO = await processWebhookEvent(input1796OoO, ctx2);

      // Lattice rejects: 'failed' is terminal → TERMINAL or BACKWARD
      expect(result1796OoO.applied).toBe(false);
      expect(['TERMINAL', 'BACKWARD']).toContain(result1796OoO.reason);

      // Assert: viva_transaction.status STILL 'failed' (not overwritten)
      {
        const r = await pool.query(
          `SELECT status FROM viva_transaction WHERE viva_transaction_id = $1`,
          [txId],
        );
        expect(r.rows[0].status).toBe('failed');
      }

      // Assert: viva_webhook_event.processed_at IS NOT NULL on 1796 out-of-order event
      // (even though the transition was rejected, the event was marked processed)
      {
        const r = await pool.query(
          `SELECT processed_at FROM viva_webhook_event WHERE viva_webhook_event_id = $1`,
          [eventId1796OoO],
        );
        expect(r.rows[0].processed_at).not.toBeNull();
      }
    },
  );
});
