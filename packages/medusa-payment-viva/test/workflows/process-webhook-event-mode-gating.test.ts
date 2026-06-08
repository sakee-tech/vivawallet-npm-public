/**
 * process-webhook-event-mode-gating.test.ts — Phase 2 slice C tests.
 *
 * Covers ISV-vs-merchant mode gating for processWebhookEvent:
 *   1. Merchant mode + 8193 → markProcessed, no side effects.
 *   2. Merchant mode + 8194 → markProcessed, no side effects.
 *   3. ISV mode + 8194 → onboarding handler runs (verification_status UPDATE).
 *   4. Merchant mode + 1796 → transaction event handled normally (regression).
 *
 * @see docs/plans/multi-mode-v0.md §6 (mode-surface gating)
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import pg from 'pg';
import { v4 as uuidv4 } from 'uuid';
import {
  checkPgReachable,
  createTestDatabase8,
  dropTestDatabase8,
  getTestConnString8,
  runMigrationsUp,
  seedTenant,
} from '../helpers/db.js';
import { processWebhookEvent } from '../../src/workflows/process-webhook-event.js';
import type { IsvPayments } from '@sakeetech/viva-payments-core/isv';
import type { VivaWebhookEnvelope } from '@sakeetech/viva-payments-core/types';

const TEST_TENANT_ID = 'tenant-modegate-test';
const TEST_VIVA_MERCHANT_ID = 'eeeaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
const TEST_CONNECTED_ACCOUNT_ID = 'fffbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';

const pgReachable = await checkPgReachable();
let connString = '';
let pool: pg.Pool;

beforeAll(async () => {
  if (!pgReachable) return;
  await createTestDatabase8('modegate');
  connString = getTestConnString8('modegate');
  await runMigrationsUp(connString);
  pool = new pg.Pool({ connectionString: connString, max: 5 });
  await seedTenant(connString, {
    tenantId: TEST_TENANT_ID,
    connectedAccountId: TEST_CONNECTED_ACCOUNT_ID,
    vivaMerchantId: TEST_VIVA_MERCHANT_ID,
  });
});

beforeEach(async () => {
  if (!pgReachable) return;
  await pool.query(`DELETE FROM viva_webhook_event`);
  await pool.query(`DELETE FROM viva_transaction`);
  // Reset verification_status to a known baseline so test 3 can detect the
  // post-handler UPDATE deterministically.
  await pool.query(
    `UPDATE viva_tenant_merchant SET verification_status = 'unverified' WHERE tenant_id = $1`,
    [TEST_TENANT_ID],
  );
});

afterAll(async () => {
  if (pool) await pool.end().catch(() => undefined);
  if (pgReachable) await dropTestDatabase8('modegate');
});

function makeMockIsvPayments(orderCode = 12345678901234): IsvPayments {
  return {
    retrieveTransaction: vi.fn(async () => ({
      transactionId: uuidv4(),
      orderCode,
      statusId: 'F',
      amount: 1000,
      currencyCode: '978',
      merchantId: TEST_VIVA_MERCHANT_ID,
      parentId: null,
      insDate: new Date().toISOString(),
      transactionTypeId: 5,
    })),
    createOrder: vi.fn(),
    refundPayment: vi.fn(),
    cancelOrder: vi.fn(),
  } as unknown as IsvPayments;
}

async function insertWebhookRow(eventTypeId: number): Promise<string> {
  const eventId = uuidv4();
  await pool.query(
    `INSERT INTO viva_webhook_event
       (viva_webhook_event_id, event_type_id, message_id, viva_merchant_id, raw_payload)
     VALUES ($1, $2, $3, $4, $5)`,
    [eventId, eventTypeId, uuidv4(), TEST_VIVA_MERCHANT_ID, JSON.stringify({})],
  );
  return eventId;
}

function makeOnboardingEnvelope(eventTypeId: 8193 | 8194, verified = true): VivaWebhookEnvelope {
  return {
    EventTypeId: eventTypeId,
    MessageId: uuidv4(),
    CorrelationId: 'corr-modegate',
    RecipientId: TEST_VIVA_MERCHANT_ID,
    MessageTypeId: 512,
    Url: 'https://example.com/viva/webhook',
    Created: new Date().toISOString(),
    Delay: null,
    EventData: {
      ConnectedAccountId: TEST_CONNECTED_ACCOUNT_ID,
      Verified: verified,
    },
  } as unknown as VivaWebhookEnvelope;
}

describe('processWebhookEvent — mode gating', () => {
  it.skipIf(!pgReachable)('1. merchant mode + 8193 → ack inert, no side effects', async () => {
    const eventId = await insertWebhookRow(8193);
    const envelope = makeOnboardingEnvelope(8193);
    const isvPayments = makeMockIsvPayments();
    const retrieveSpy = isvPayments.retrieveTransaction as unknown as ReturnType<typeof vi.fn>;

    const result = await processWebhookEvent(
      { eventId, eventTypeId: 8193, envelope, tenantId: TEST_TENANT_ID },
      {
        pool,
        isvPayments,
        logger: { info: () => undefined, warn: () => undefined, error: () => undefined },
        mode: 'merchant',
      },
    );

    expect(result.applied).toBe(false);
    expect(result.reason).toBe('MODE_GATED');

    // processed_at SET, error NULL (acknowledged + inert)
    const event = await pool.query<{ processed_at: Date | null; error: unknown }>(
      `SELECT processed_at, error FROM viva_webhook_event WHERE viva_webhook_event_id = $1`,
      [eventId],
    );
    expect(event.rows[0]?.processed_at).not.toBeNull();
    expect(event.rows[0]?.error).toBeNull();

    // No transaction fetch attempted
    expect(retrieveSpy).not.toHaveBeenCalled();

    // verification_status untouched (still 'unverified' baseline)
    const tenant = await pool.query<{ verification_status: string | null }>(
      `SELECT verification_status FROM viva_tenant_merchant WHERE tenant_id = $1`,
      [TEST_TENANT_ID],
    );
    expect(tenant.rows[0]?.verification_status).toBe('unverified');
  });

  it.skipIf(!pgReachable)('2. merchant mode + 8194 → ack inert, no side effects', async () => {
    const eventId = await insertWebhookRow(8194);
    const envelope = makeOnboardingEnvelope(8194, true);

    const result = await processWebhookEvent(
      { eventId, eventTypeId: 8194, envelope, tenantId: TEST_TENANT_ID },
      {
        pool,
        isvPayments: makeMockIsvPayments(),
        logger: { info: () => undefined, warn: () => undefined, error: () => undefined },
        mode: 'merchant',
      },
    );

    expect(result.applied).toBe(false);
    expect(result.reason).toBe('MODE_GATED');

    const event = await pool.query<{ processed_at: Date | null }>(
      `SELECT processed_at FROM viva_webhook_event WHERE viva_webhook_event_id = $1`,
      [eventId],
    );
    expect(event.rows[0]?.processed_at).not.toBeNull();

    // verification_status was 'unverified' baseline; 8194 with Verified=true
    // would otherwise have flipped it to 'verified'. Confirm it didn't.
    const tenant = await pool.query<{ verification_status: string | null }>(
      `SELECT verification_status FROM viva_tenant_merchant WHERE tenant_id = $1`,
      [TEST_TENANT_ID],
    );
    expect(tenant.rows[0]?.verification_status).toBe('unverified');
  });

  it.skipIf(!pgReachable)('3. ISV mode + 8194 → onboarding handler runs and applies verification', async () => {
    const eventId = await insertWebhookRow(8194);
    const envelope = makeOnboardingEnvelope(8194, true);

    const result = await processWebhookEvent(
      { eventId, eventTypeId: 8194, envelope, tenantId: TEST_TENANT_ID },
      {
        pool,
        isvPayments: makeMockIsvPayments(),
        logger: { info: () => undefined, warn: () => undefined, error: () => undefined },
        mode: 'isv',
      },
    );

    expect(result.applied).toBe(true);

    // verification_status flipped to 'verified' by the onboarding handler.
    const tenant = await pool.query<{ verification_status: string | null }>(
      `SELECT verification_status FROM viva_tenant_merchant WHERE tenant_id = $1`,
      [TEST_TENANT_ID],
    );
    expect(tenant.rows[0]?.verification_status).toBe('verified');
  });

  it.skipIf(!pgReachable)('4. merchant mode + 1796 → transaction event handled normally (regression)', async () => {
    // Insert a transaction row that 1796 should transition initiated→captured.
    const orderCode = '12340000099999';
    const txId = uuidv4();
    await pool.query(
      `INSERT INTO viva_transaction
         (viva_transaction_id, viva_order_code, medusa_payment_id, viva_merchant_id, status,
          amount_minor, refunded_amount_minor, currency_code, idempotency_key, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, now(), now())`,
      [txId, orderCode, uuidv4(), TEST_VIVA_MERCHANT_ID, 'initiated', 1000, 0, '978', uuidv4()],
    );
    const eventId = await insertWebhookRow(1796);

    const envelope = {
      EventTypeId: 1796,
      MessageId: uuidv4(),
      CorrelationId: 'corr-merchant-1796',
      RecipientId: TEST_VIVA_MERCHANT_ID,
      MessageTypeId: 512,
      Url: 'https://example.com/viva/webhook',
      Created: new Date().toISOString(),
      Delay: null,
      EventData: {
        TransactionId: uuidv4(),
        OrderCode: Number(orderCode),
        StatusId: 'F',
        Amount: 1000,
        CurrencyCode: '978',
        MerchantId: TEST_VIVA_MERCHANT_ID,
        ConnectedAccountId: TEST_CONNECTED_ACCOUNT_ID,
      },
    } as unknown as VivaWebhookEnvelope;

    const result = await processWebhookEvent(
      { eventId, eventTypeId: 1796, envelope, tenantId: TEST_TENANT_ID },
      {
        pool,
        isvPayments: makeMockIsvPayments(Number(orderCode)),
        logger: { info: () => undefined, warn: () => undefined, error: () => undefined },
        mode: 'merchant',
      },
    );

    expect(result.applied).toBe(true);

    const row = await pool.query<{ status: string }>(
      `SELECT status FROM viva_transaction WHERE viva_order_code = $1`,
      [orderCode],
    );
    expect(row.rows[0]?.status).toBe('captured');
  });
});
