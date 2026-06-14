/**
 * reprocess-unresolved.test.ts — Integration tests for A6 reprocess job.
 *
 * Covers:
 *   1. Insert webhook with null tenant. Run reprocess with minAgeSeconds=0.
 *      Stub resolver succeeds → event re-dispatched, retry_count incremented.
 *   2. Stub resolver fails for maxRetries=1. Second pass marks abandoned (processed_at set).
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
  seedTenant,
} from '../helpers/db.js';
import { reprocessUnresolvedTenants } from '../../src/workflows/reprocess-unresolved-tenants.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const TEST_TENANT_ID = 'tenant-reprocess-test-001';
const TEST_VIVA_MERCHANT_ID = 'eeeaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
const TEST_CONNECTED_ACCOUNT_ID = 'fffbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';

const pgReachable = await checkPgReachable();
let connString = '';
let pool: pg.Pool;

// ---------------------------------------------------------------------------
// DB lifecycle
// ---------------------------------------------------------------------------

beforeAll(async () => {
  if (!pgReachable) return;
  await createTestDatabase8('rut');
  connString = getTestConnString8('rut');
  await runMigrationsUp(connString);
  pool = new pg.Pool({ connectionString: connString, max: 3 });
  await seedTenant(connString, {
    tenantId: TEST_TENANT_ID,
    connectedAccountId: TEST_CONNECTED_ACCOUNT_ID,
    vivaMerchantId: TEST_VIVA_MERCHANT_ID,
  });
});

beforeEach(async () => {
  if (!pgReachable) return;
  await pool.query(`DELETE FROM viva_webhook_event`);
});

afterAll(async () => {
  if (pool) await pool.end().catch(() => undefined);
  if (pgReachable) await dropTestDatabase8('rut');
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function insertUnresolvedEvent(opts: {
  vivaMerchantId?: string | null;
  retryCount?: number;
}): Promise<string> {
  const eventId = uuidv4();
  const retryCount = opts.retryCount ?? 0;
  await pool.query(
    `INSERT INTO viva_webhook_event
       (viva_webhook_event_id, event_type_id, message_id, viva_merchant_id, raw_payload,
        retry_count, received_at)
     VALUES ($1, $2, $3, $4, $5, $6, now() - interval '1 minute')`,
    [
      eventId,
      1796,
      uuidv4(),
      opts.vivaMerchantId ?? TEST_VIVA_MERCHANT_ID,
      JSON.stringify({ EventTypeId: 1796, EventData: { MerchantId: opts.vivaMerchantId ?? TEST_VIVA_MERCHANT_ID } }),
      retryCount,
    ],
  );
  return eventId;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('reprocessUnresolvedTenants (A6)', () => {
  const logger = { info: () => undefined, warn: () => undefined, error: () => undefined };

  it.skipIf(!pgReachable)('1. Resolver succeeds → event re-dispatched, retry_count incremented', async () => {
    const eventId = await insertUnresolvedEvent({ vivaMerchantId: TEST_VIVA_MERCHANT_ID });
    const emitted: Array<Record<string, unknown>> = [];

    const result = await reprocessUnresolvedTenants({
      pool,
      resolveMerchant: async () => ({ tenantId: TEST_TENANT_ID }),
      emitEvent: async (_name, data) => { emitted.push(data); },
      logger,
      minAgeSeconds: 0,
      maxRetries: 5,
    });

    expect(result.retried).toBe(1);
    expect(result.resolved).toBe(1);
    expect(result.abandoned).toBe(0);

    // Event was re-emitted
    expect(emitted.length).toBe(1);
    expect(emitted[0]?.['eventId']).toBe(eventId);
    expect(emitted[0]?.['tenantId']).toBe(TEST_TENANT_ID);

    // retry_count incremented
    const row = await pool.query(`SELECT retry_count FROM viva_webhook_event WHERE viva_webhook_event_id = $1`, [eventId]);
    expect(row.rows[0]?.retry_count).toBe(1);
  });

  it.skipIf(!pgReachable)('2. Resolver fails, maxRetries=1 → second pass marks abandoned', async () => {
    // Insert with retry_count=0 (first attempt)
    const eventId = await insertUnresolvedEvent({ vivaMerchantId: TEST_VIVA_MERCHANT_ID, retryCount: 0 });

    // First pass: unresolved, not yet at maxRetries (retry_count 0 < maxRetries-1=0? No, 0+1 >= 1)
    // With maxRetries=1: on first pass retry_count(0) + 1 >= 1 → abandoned immediately
    const result1 = await reprocessUnresolvedTenants({
      pool,
      resolveMerchant: async () => null, // always fails
      logger,
      minAgeSeconds: 0,
      maxRetries: 1,
    });

    expect(result1.retried).toBe(1);
    expect(result1.abandoned).toBe(1);
    expect(result1.resolved).toBe(0);

    // processed_at is set (abandoned)
    const row = await pool.query(`SELECT processed_at, retry_count FROM viva_webhook_event WHERE viva_webhook_event_id = $1`, [eventId]);
    expect(row.rows[0]?.processed_at).not.toBeNull();
    expect(row.rows[0]?.retry_count).toBe(1);

    // Second pass: already processed, should find 0 candidates
    const result2 = await reprocessUnresolvedTenants({
      pool,
      resolveMerchant: async () => null,
      logger,
      minAgeSeconds: 0,
      maxRetries: 1,
    });

    expect(result2.retried).toBe(0);
  });
});
