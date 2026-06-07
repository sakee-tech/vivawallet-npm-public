/**
 * webhook-failure-recording.test.ts — Phase 2 slice D schema migration.
 *
 * Covers Migration_20260425000004_webhook_error_and_nullable_merchant:
 *   1. viva_webhook_event row created via INSERT has defaults
 *      retry_count=0 + error=NULL (forward-safe migration).
 *   2. recordWebhookFailure writes the error envelope and bumps retry_count.
 *      Successive failures keep incrementing.
 *   3. viva_transaction.viva_merchant_id accepts NULL (merchant-mode rows).
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import pg from 'pg';
import { v4 as uuidv4 } from 'uuid';
import {
  checkPgReachable,
  createTestDatabase8,
  dropTestDatabase8,
  getTestConnString8,
  runMigrationsUp,
} from '../helpers/db.js';
import { recordWebhookFailure } from '../../src/workflows/process-webhook-event.js';

const pgReachable = await checkPgReachable();
let connString = '';
let pool: pg.Pool;

beforeAll(async () => {
  if (!pgReachable) return;
  await createTestDatabase8('wfr');
  connString = getTestConnString8('wfr');
  await runMigrationsUp(connString);
  pool = new pg.Pool({ connectionString: connString, max: 3 });
});

beforeEach(async () => {
  if (!pgReachable) return;
  await pool.query(`DELETE FROM viva_webhook_event`);
  await pool.query(`DELETE FROM viva_transaction`);
});

afterAll(async () => {
  if (pool) await pool.end().catch(() => undefined);
  if (pgReachable) await dropTestDatabase8('wfr');
});

async function insertWebhookEvent(): Promise<string> {
  const eventId = uuidv4();
  await pool.query(
    `INSERT INTO viva_webhook_event
       (viva_webhook_event_id, event_type_id, message_id, raw_payload)
     VALUES ($1, $2, $3, $4)`,
    [eventId, 1796, uuidv4(), JSON.stringify({ EventTypeId: 1796, MessageId: 'm' })],
  );
  return eventId;
}

describe.skipIf(!pgReachable)('schema migration: webhook event error + retry_count', () => {
  it('newly inserted webhook event has retry_count=0 and error=NULL by default', async () => {
    const eventId = await insertWebhookEvent();

    const result = await pool.query<{ error: string | null; retry_count: number }>(
      `SELECT error, retry_count FROM viva_webhook_event WHERE viva_webhook_event_id = $1`,
      [eventId],
    );

    expect(result.rows[0]?.error).toBeNull();
    expect(result.rows[0]?.retry_count).toBe(0);
  });

  it('recordWebhookFailure writes error envelope and bumps retry_count', async () => {
    const eventId = await insertWebhookEvent();
    const boom = new Error('Viva returned 503');
    boom.name = 'VivaApiError';

    await recordWebhookFailure(pool, eventId, boom);

    const result = await pool.query<{
      error: string | null;
      retry_count: number;
      processed_at: Date | null;
    }>(
      `SELECT error, retry_count, processed_at
         FROM viva_webhook_event
        WHERE viva_webhook_event_id = $1`,
      [eventId],
    );
    const row = result.rows[0];
    expect(row).toBeDefined();
    expect(row?.retry_count).toBe(1);
    expect(row?.processed_at).toBeNull(); // failure must NOT mark processed
    expect(row?.error).toBeTruthy();

    const envelope = JSON.parse(row!.error!) as Record<string, unknown>;
    expect(envelope['name']).toBe('VivaApiError');
    expect(envelope['message']).toBe('Viva returned 503');
    expect(typeof envelope['at']).toBe('string');
  });

  it('recordWebhookFailure increments retry_count on successive failures', async () => {
    const eventId = await insertWebhookEvent();

    await recordWebhookFailure(pool, eventId, new Error('first'));
    await recordWebhookFailure(pool, eventId, new Error('second'));
    await recordWebhookFailure(pool, eventId, new Error('third'));

    const result = await pool.query<{ retry_count: number; error: string | null }>(
      `SELECT retry_count, error FROM viva_webhook_event WHERE viva_webhook_event_id = $1`,
      [eventId],
    );
    expect(result.rows[0]?.retry_count).toBe(3);
    // Latest error envelope wins.
    const envelope = JSON.parse(result.rows[0]!.error!) as Record<string, unknown>;
    expect(envelope['message']).toBe('third');
  });
});

describe.skipIf(!pgReachable)('schema migration: viva_transaction.viva_merchant_id nullable', () => {
  it('accepts INSERT with viva_merchant_id = NULL (merchant-mode row)', async () => {
    const txId = uuidv4();
    await pool.query(
      `INSERT INTO viva_transaction
         (viva_transaction_id, viva_order_code, medusa_payment_id, viva_merchant_id, status,
          amount_minor, refunded_amount_minor, currency_code, idempotency_key)
       VALUES ($1, NULL, $2, NULL, 'initiated', 1000, 0, '978', $3)`,
      [txId, `pay_${txId}`, `idem_${txId}`],
    );

    const result = await pool.query<{ viva_merchant_id: string | null }>(
      `SELECT viva_merchant_id FROM viva_transaction WHERE viva_transaction_id = $1`,
      [txId],
    );
    expect(result.rows[0]?.viva_merchant_id).toBeNull();
  });
});
