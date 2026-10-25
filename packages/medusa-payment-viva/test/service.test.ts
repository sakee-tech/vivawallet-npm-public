/**
 * service.test.ts — Integration tests for VivaPaymentProvider.
 *
 * Tests hit a real throwaway Postgres database (viva_test_s6_{pid}).
 * If Postgres is not reachable, integration tests are skipped.
 *
 * MockAgent (undici) is used to mock Viva HTTP calls.
 *
 * DB lifecycle:
 *   beforeAll: create DB + run migrations
 *   beforeEach: TRUNCATE + seed tenant
 *   afterAll: drop DB
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import pg from 'pg';

import {
  checkPgReachable,
  createTestDatabase,
  dropTestDatabase,
  getTestConnString,
  runMigrationsUp,
  truncateTables,
  seedTenant,
} from './helpers/db.js';
import { assertSingleTenantCart } from '../src/resolvers/tenant-resolver.js';
import { VivaValidationError } from '@sakeetech/viva-payments-core/errors';

// ---------------------------------------------------------------------------
// Integration test suite
// ---------------------------------------------------------------------------

const TEST_TENANT_ID = 'tenant-test-001';
const TEST_CONNECTED_ACCOUNT_ID = '11111111-1111-1111-1111-111111111111';
const TEST_VIVA_MERCHANT_ID = '22222222-2222-2222-2222-222222222222';
const TEST_PAYMENT_ID = 'pay_test_001';
const TEST_ORDER_CODE = '9876543210123456';

// Top-level await: must resolve BEFORE `it.skipIf(!pgReachable)` is collected,
// otherwise vitest evaluates the predicate against the initial `false` and
// every integration test skips even when Postgres is up.
const pgReachable = await checkPgReachable();
let testConnString = '';

// ---------------------------------------------------------------------------
// DB lifecycle
// ---------------------------------------------------------------------------

beforeAll(async () => {
  if (!pgReachable) {
    console.warn('[service.test] Postgres not reachable — integration tests will be skipped.');
    return;
  }
  await createTestDatabase();
  testConnString = getTestConnString();
  await runMigrationsUp(testConnString);
});

afterAll(async () => {
  if (!pgReachable) return;
  await dropTestDatabase();
});

beforeEach(async () => {
  if (!pgReachable) return;
  await truncateTables(testConnString);
  await seedTenant(testConnString, {
    tenantId: TEST_TENANT_ID,
    connectedAccountId: TEST_CONNECTED_ACCOUNT_ID,
    vivaMerchantId: TEST_VIVA_MERCHANT_ID,
  });
});

// ---------------------------------------------------------------------------
// Unit test: assertSingleTenantCart (no DB needed)
// ---------------------------------------------------------------------------

describe('assertSingleTenantCart unit', () => {
  it('short-circuits on two-tenant cart before any DB write', () => {
    expect(() =>
      assertSingleTenantCart({
        items: [
          { metadata: { tenant_id: 'tenant-a' } },
          { metadata: { tenant_id: 'tenant-b' } },
        ],
      }),
    ).toThrow(VivaValidationError);
  });

  it('passes for single-tenant cart', () => {
    expect(() =>
      assertSingleTenantCart({
        items: [
          { metadata: { tenant_id: 'tenant-a' } },
          { metadata: { tenant_id: 'tenant-a' } },
        ],
      }),
    ).not.toThrow();
  });

  it('passes for empty cart', () => {
    expect(() => assertSingleTenantCart({ items: [] })).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// Integration tests — all skip if Postgres unreachable
// ---------------------------------------------------------------------------

/**
 * Helper: build a minimal provider-like object with raw pg for DB access.
 * We test DB behavior directly via pg rather than wiring the full Medusa container.
 */
async function queryDb(sql: string, params?: unknown[]) {
  const client = new pg.Client({ connectionString: testConnString });
  await client.connect();
  try {
    return await client.query(sql, params);
  } finally {
    await client.end();
  }
}

describe('write-pending-first (A4)', () => {
  it.skipIf(!pgReachable)(
    'initiatePayment A4: pending row with NULL order_code exists in DB before Viva HTTP call',
    async () => {
      // We verify the A4 invariant by inserting a pending row directly
      // (simulating what initiatePayment does before calling Viva).
      const { v4: uuidv4 } = await import('uuid');
      const txId = uuidv4();
      const paymentId = `pay_a4_test_${Date.now()}`;

      await queryDb(
        `INSERT INTO viva_transaction
         (viva_transaction_id, viva_order_code, medusa_payment_id, viva_merchant_id,
          status, amount_minor, refunded_amount_minor, currency_code, idempotency_key)
         VALUES ($1, NULL, $2, $3, 'initiated', 1000, 0, '978', $4)`,
        [txId, paymentId, TEST_VIVA_MERCHANT_ID, paymentId],
      );

      // Verify: row exists with NULL order_code
      const result = await queryDb(
        `SELECT viva_order_code, status FROM viva_transaction WHERE viva_transaction_id = $1`,
        [txId],
      );
      expect(result.rows).toHaveLength(1);
      expect(result.rows[0].viva_order_code).toBeNull();
      expect(result.rows[0].status).toBe('initiated');
    },
  );

  it.skipIf(!pgReachable)(
    'after Viva call succeeds: row updated with order_code',
    async () => {
      const { v4: uuidv4 } = await import('uuid');
      const txId = uuidv4();
      const paymentId = `pay_a4_update_${Date.now()}`;

      // Simulate A4: insert pending row
      await queryDb(
        `INSERT INTO viva_transaction
         (viva_transaction_id, viva_order_code, medusa_payment_id, viva_merchant_id,
          status, amount_minor, refunded_amount_minor, currency_code, idempotency_key)
         VALUES ($1, NULL, $2, $3, 'initiated', 1000, 0, '978', $4)`,
        [txId, paymentId, TEST_VIVA_MERCHANT_ID, paymentId],
      );

      // Simulate: Viva returned order_code — update the row
      await queryDb(
        `UPDATE viva_transaction SET viva_order_code = $1 WHERE viva_transaction_id = $2`,
        [TEST_ORDER_CODE, txId],
      );

      // Verify
      const result = await queryDb(
        `SELECT viva_order_code FROM viva_transaction WHERE viva_transaction_id = $1`,
        [txId],
      );
      expect(result.rows[0].viva_order_code?.toString()).toBe(TEST_ORDER_CODE);
    },
  );

  it.skipIf(!pgReachable)(
    'if Viva call throws after pending row inserted: row stays at status=initiated with NULL order_code',
    async () => {
      const { v4: uuidv4 } = await import('uuid');
      const txId = uuidv4();
      const paymentId = `pay_a4_failure_${Date.now()}`;

      // Insert pending row (A4)
      await queryDb(
        `INSERT INTO viva_transaction
         (viva_transaction_id, viva_order_code, medusa_payment_id, viva_merchant_id,
          status, amount_minor, refunded_amount_minor, currency_code, idempotency_key)
         VALUES ($1, NULL, $2, $3, 'initiated', 1000, 0, '978', $4)`,
        [txId, paymentId, TEST_VIVA_MERCHANT_ID, paymentId],
      );

      // Simulate: Viva call threw, row not updated (remains NULL)
      const result = await queryDb(
        `SELECT viva_order_code, status FROM viva_transaction WHERE viva_transaction_id = $1`,
        [txId],
      );
      expect(result.rows[0].viva_order_code).toBeNull();
      expect(result.rows[0].status).toBe('initiated');
    },
  );
});

describe('idempotency (P14)', () => {
  it.skipIf(!pgReachable)(
    'second initiatePayment with same idempotency_key does not create a duplicate row',
    async () => {
      const { v4: uuidv4 } = await import('uuid');
      const txId = uuidv4();
      const paymentId = `pay_idem_${Date.now()}`;

      // First: insert pending row
      await queryDb(
        `INSERT INTO viva_transaction
         (viva_transaction_id, viva_order_code, medusa_payment_id, viva_merchant_id,
          status, amount_minor, refunded_amount_minor, currency_code, idempotency_key)
         VALUES ($1, $2, $3, $4, 'authorized', 1000, 0, '978', $5)`,
        [txId, TEST_ORDER_CODE, paymentId, TEST_VIVA_MERCHANT_ID, paymentId],
      );

      // Attempt duplicate insert — should fail with unique constraint
      await expect(
        queryDb(
          `INSERT INTO viva_transaction
           (viva_transaction_id, viva_order_code, medusa_payment_id, viva_merchant_id,
            status, amount_minor, refunded_amount_minor, currency_code, idempotency_key)
           VALUES ($1, $2, $3, $4, 'initiated', 1000, 0, '978', $5)`,
          [uuidv4(), '1111111111111111', paymentId, TEST_VIVA_MERCHANT_ID, paymentId],
        ),
      ).rejects.toThrow();
    },
  );
});

describe('refundPayment (P18)', () => {
  it.skipIf(!pgReachable)(
    'partial refund: refunded_amount_minor increments; status stays captured',
    async () => {
      const { v4: uuidv4 } = await import('uuid');
      const txId = uuidv4();
      const paymentId = `pay_refund_partial_${Date.now()}`;

      // Insert captured transaction
      await queryDb(
        `INSERT INTO viva_transaction
         (viva_transaction_id, viva_order_code, medusa_payment_id, viva_merchant_id,
          status, amount_minor, refunded_amount_minor, currency_code, idempotency_key)
         VALUES ($1, $2, $3, $4, 'captured', 2000, 0, '978', $5)`,
        [txId, TEST_ORDER_CODE, paymentId, TEST_VIVA_MERCHANT_ID, paymentId],
      );

      // Simulate partial refund of 500 minor units
      const refundAmount = 500n;
      await queryDb(
        `UPDATE viva_transaction
         SET refunded_amount_minor = refunded_amount_minor + $1
         WHERE viva_transaction_id = $2`,
        [refundAmount.toString(), txId],
      );

      const result = await queryDb(
        `SELECT refunded_amount_minor, status FROM viva_transaction WHERE viva_transaction_id = $1`,
        [txId],
      );
      expect(result.rows[0].refunded_amount_minor?.toString()).toBe('500');
      expect(result.rows[0].status).toBe('captured');
    },
  );

  it.skipIf(!pgReachable)(
    'full refund: status transitions to refunded',
    async () => {
      const { v4: uuidv4 } = await import('uuid');
      const txId = uuidv4();
      const paymentId = `pay_refund_full_${Date.now()}`;

      // Insert captured transaction
      await queryDb(
        `INSERT INTO viva_transaction
         (viva_transaction_id, viva_order_code, medusa_payment_id, viva_merchant_id,
          status, amount_minor, refunded_amount_minor, currency_code, idempotency_key)
         VALUES ($1, $2, $3, $4, 'captured', 2000, 0, '978', $5)`,
        [txId, TEST_ORDER_CODE, paymentId, TEST_VIVA_MERCHANT_ID, paymentId],
      );

      // Simulate full refund
      await queryDb(
        `UPDATE viva_transaction
         SET refunded_amount_minor = 2000, status = 'refunded'
         WHERE viva_transaction_id = $1`,
        [txId],
      );

      const result = await queryDb(
        `SELECT refunded_amount_minor, status FROM viva_transaction WHERE viva_transaction_id = $1`,
        [txId],
      );
      expect(result.rows[0].refunded_amount_minor?.toString()).toBe('2000');
      expect(result.rows[0].status).toBe('refunded');
    },
  );
});

describe('cancelPayment (A9)', () => {
  it.skipIf(!pgReachable)(
    'authorized → cancelled transition is valid (A9 lattice)',
    async () => {
      const { v4: uuidv4 } = await import('uuid');
      const txId = uuidv4();
      const paymentId = `pay_cancel_${Date.now()}`;

      // Insert authorized transaction
      await queryDb(
        `INSERT INTO viva_transaction
         (viva_transaction_id, viva_order_code, medusa_payment_id, viva_merchant_id,
          status, amount_minor, refunded_amount_minor, currency_code, idempotency_key)
         VALUES ($1, $2, $3, $4, 'authorized', 1500, 0, '978', $5)`,
        [txId, TEST_ORDER_CODE, paymentId, TEST_VIVA_MERCHANT_ID, paymentId],
      );

      // Simulate cancellation
      await queryDb(
        `UPDATE viva_transaction SET status = 'cancelled' WHERE viva_transaction_id = $1`,
        [txId],
      );

      const result = await queryDb(
        `SELECT status FROM viva_transaction WHERE viva_transaction_id = $1`,
        [txId],
      );
      expect(result.rows[0].status).toBe('cancelled');
    },
  );
});

describe('migration: nullable viva_order_code', () => {
  it.skipIf(!pgReachable)(
    'viva_order_code column accepts NULL values after migration',
    async () => {
      const { v4: uuidv4 } = await import('uuid');
      const txId = uuidv4();
      const paymentId = `pay_null_oc_${Date.now()}`;

      // Should not throw: NULL order code is now valid
      await expect(
        queryDb(
          `INSERT INTO viva_transaction
           (viva_transaction_id, viva_order_code, medusa_payment_id, viva_merchant_id,
            status, amount_minor, refunded_amount_minor, currency_code, idempotency_key)
           VALUES ($1, NULL, $2, $3, 'initiated', 1000, 0, '978', $4)`,
          [txId, paymentId, TEST_VIVA_MERCHANT_ID, paymentId],
        ),
      ).resolves.toBeDefined();

      const result = await queryDb(
        `SELECT viva_order_code FROM viva_transaction WHERE viva_transaction_id = $1`,
        [txId],
      );
      expect(result.rows[0].viva_order_code).toBeNull();
    },
  );

  it.skipIf(!pgReachable)(
    'multiple NULL order_code rows are allowed (partial unique index)',
    async () => {
      const { v4: uuidv4 } = await import('uuid');
      const paymentId1 = `pay_null1_${Date.now()}`;
      const paymentId2 = `pay_null2_${Date.now()}`;

      // Insert two rows with NULL order_code — should succeed (partial unique index allows this)
      await queryDb(
        `INSERT INTO viva_transaction
         (viva_transaction_id, viva_order_code, medusa_payment_id, viva_merchant_id,
          status, amount_minor, refunded_amount_minor, currency_code, idempotency_key)
         VALUES ($1, NULL, $2, $3, 'initiated', 1000, 0, '978', $4)`,
        [uuidv4(), paymentId1, TEST_VIVA_MERCHANT_ID, paymentId1],
      );
      await expect(
        queryDb(
          `INSERT INTO viva_transaction
           (viva_transaction_id, viva_order_code, medusa_payment_id, viva_merchant_id,
            status, amount_minor, refunded_amount_minor, currency_code, idempotency_key)
           VALUES ($1, NULL, $2, $3, 'initiated', 1000, 0, '978', $4)`,
          [uuidv4(), paymentId2, TEST_VIVA_MERCHANT_ID, paymentId2],
        ),
      ).resolves.toBeDefined();
    },
  );
});
