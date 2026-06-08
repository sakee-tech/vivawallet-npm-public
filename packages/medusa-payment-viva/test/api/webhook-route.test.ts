/**
 * webhook-route.test.ts — Integration tests for GET/POST /viva/webhook.
 *
 * Tests the route handlers directly (no full Medusa server required).
 * Uses a real Postgres throwaway DB and mock objects for the container.
 *
 * Covers:
 *   1. GET returns { Key } 200.
 *   2. GET with empty key returns 500.
 *   3. POST 1796 happy: rawBody captured, INSERT row, emit event.
 *   4. POST 1796 duplicate: ON CONFLICT → no INSERT, no emit.
 *   5. POST 7936 not HMAC-gated (CSO Finding #3 cleanup).
 *   7. POST from non-allowlisted IP: 403, no INSERT.
 *   7b. CSO Finding #2: leftmost X-Forwarded-For spoof ignored at depth=0.
 *   7c. trustedProxyDepth=1 trusts only the rightmost X-Forwarded-For entry.
 *   8. POST with unknown MerchantId: INSERT with NULL tenant, metric logged.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import pg from 'pg';
import {
  checkPgReachable,
  createTestDatabase8,
  dropTestDatabase8,
  getTestConnString8,
  runMigrationsUp,
  seedTenant,
} from '../helpers/db.js';
import { GET, POST } from '../../src/api/viva/webhook/route.js';
import type { MedusaRequest, MedusaResponse } from '@medusajs/framework/http';

// ---------------------------------------------------------------------------
// Test constants
// ---------------------------------------------------------------------------

const TEST_TENANT_ID = 'tenant-webhook-test-001';
const TEST_CONNECTED_ACCOUNT_ID = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
const TEST_VIVA_MERCHANT_ID = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';
const TEST_MESSAGE_ID = 'cccccccc-cccc-cccc-cccc-cccccccccccc';
const TEST_TRANSACTION_ID = 'dddddddd-dddd-dddd-dddd-dddddddddddd';
const VERIFICATION_KEY = 'test-webhook-key-12345';

const ORIG_DATABASE_URL = process.env['DATABASE_URL'];
const pgReachable = await checkPgReachable();
let connString = '';
let pool: pg.Pool;

// ---------------------------------------------------------------------------
// Mock helpers
// ---------------------------------------------------------------------------

interface EmittedEvent {
  name: string;
  data: Record<string, unknown>;
}

function makeReqRes(opts: {
  method?: string;
  ip?: string;
  headers?: Record<string, string>;
  rawBody?: Buffer;
  env?: Record<string, string | undefined>;
}): { req: MedusaRequest; res: MedusaResponse; emitted: EmittedEvent[] } {
  const emitted: EmittedEvent[] = [];

  const scope = {
    resolve: (key: string) => {
      if (key === 'logger') {
        return { info: () => undefined, warn: () => undefined, error: () => undefined };
      }
      if (key === 'event_bus') {
        return {
          emit: async (msg: { name: string; data: Record<string, unknown> }) => {
            emitted.push(msg);
          },
        };
      }
      return null;
    },
  };

  const req = {
    method: opts.method ?? 'GET',
    ip: opts.ip ?? '127.0.0.1',
    headers: opts.headers ?? {},
    socket: { remoteAddress: opts.ip ?? '127.0.0.1' },
    rawBody: opts.rawBody,
    scope,
    on: () => undefined,
  } as unknown as MedusaRequest;

  const responseData: { statusCode?: number; body?: unknown; ended?: boolean } = {};
  const res = {
    status: (code: number) => {
      responseData.statusCode = code;
      return res;
    },
    json: (body: unknown) => {
      responseData.body = body;
      return res;
    },
    end: () => {
      responseData.ended = true;
      return res;
    },
    setHeader: () => res,
    _data: responseData,
  } as unknown as MedusaResponse;

  return { req, res, emitted };
}

function buildEnvelope(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    Url: 'https://example.com/viva/webhook',
    EventTypeId: 1796,
    MessageId: TEST_MESSAGE_ID,
    RecipientId: TEST_VIVA_MERCHANT_ID,
    MessageTypeId: 512,
    CorrelationId: 'corr-001',
    Created: new Date().toISOString(),
    Delay: null,
    EventData: {
      TransactionId: TEST_TRANSACTION_ID,
      OrderCode: 12345678901234,
      StatusId: 'F',
      Amount: 1000,
      CurrencyCode: '978',
      MerchantId: TEST_VIVA_MERCHANT_ID,
      ConnectedAccountId: TEST_CONNECTED_ACCOUNT_ID,
      ParentId: null,
      InsDate: new Date().toISOString(),
      TransactionTypeId: 5,
      Email: null,
      FullName: null,
      CardNumber: null,
      CardTypeId: 0,
      MerchantTrns: 'pay_test_001',
      CustomerTrns: null,
      SourceCode: 'Default',
      TotalFee: 0,
      ...((overrides['EventData'] as Record<string, unknown> | undefined) ?? {}),
    },
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// DB lifecycle
// ---------------------------------------------------------------------------

beforeAll(async () => {
  if (!pgReachable) {
    console.warn('[webhook-route.test] Postgres not reachable — integration tests will be skipped.');
    return;
  }
  await createTestDatabase8('api');
  connString = getTestConnString8('api');
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
  // Restore original DATABASE_URL so dropTestDatabase8 connects to the admin DB, not the test DB.
  if (ORIG_DATABASE_URL !== undefined) {
    process.env['DATABASE_URL'] = ORIG_DATABASE_URL;
  } else {
    delete process.env['DATABASE_URL'];
  }
  if (pgReachable) await dropTestDatabase8('api');
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('GET /viva/webhook', () => {
  it('1. returns { Key } 200 when key is set', async () => {
    process.env['VIVA_WEBHOOK_VERIFICATION_KEY'] = VERIFICATION_KEY;
    const { req, res } = makeReqRes({ method: 'GET' });
    await GET(req, res as MedusaResponse);
    const data = (res as unknown as { _data: { statusCode?: number; body?: unknown } })._data;
    expect(data.statusCode).toBe(200);
    expect((data.body as { Key?: string })?.Key).toBe(VERIFICATION_KEY);
  });

  it('2. returns 500 when VIVA_WEBHOOK_VERIFICATION_KEY is empty', async () => {
    const saved = process.env['VIVA_WEBHOOK_VERIFICATION_KEY'];
    process.env['VIVA_WEBHOOK_VERIFICATION_KEY'] = '';
    const { req, res } = makeReqRes({ method: 'GET' });
    await GET(req, res as MedusaResponse);
    const data = (res as unknown as { _data: { statusCode?: number } })._data;
    expect(data.statusCode).toBe(500);
    process.env['VIVA_WEBHOOK_VERIFICATION_KEY'] = saved;
  });
});

describe('POST /viva/webhook', () => {
  it.skipIf(!pgReachable)('3. 1796 happy: inserts row and emits event', async () => {
    process.env['DATABASE_URL'] = connString;
    process.env['VIVA_ENVIRONMENT'] = 'demo';
    process.env['VIVA_WEBHOOK_IP_ALLOWLIST_BYPASS'] = 'true';
    process.env['VIVA_WEBHOOK_VERIFICATION_KEY'] = VERIFICATION_KEY;

    const envelope = buildEnvelope();
    const body = Buffer.from(JSON.stringify(envelope));

    const { req, res, emitted } = makeReqRes({
      method: 'POST',
      ip: '127.0.0.1',
      rawBody: body,
    });

    await POST(req, res as MedusaResponse);

    const data = (res as unknown as { _data: { statusCode?: number; ended?: boolean } })._data;
    expect(data.ended).toBe(true);

    // Check DB row
    const dbResult = await pool.query(
      `SELECT * FROM viva_webhook_event WHERE message_id = $1`,
      [TEST_MESSAGE_ID],
    );
    expect(dbResult.rows.length).toBe(1);
    expect(dbResult.rows[0]?.viva_merchant_id).toBe(TEST_VIVA_MERCHANT_ID);

    // Event was emitted (A2 gate passed)
    expect(emitted.length).toBe(1);
    expect(emitted[0]?.name).toBe('viva.webhook.received');
    expect((emitted[0]?.data as { eventId?: string })?.eventId).toBeTruthy();
  });

  it.skipIf(!pgReachable)('4. duplicate MessageId: no INSERT, no emit', async () => {
    process.env['DATABASE_URL'] = connString;
    process.env['VIVA_ENVIRONMENT'] = 'demo';
    process.env['VIVA_WEBHOOK_IP_ALLOWLIST_BYPASS'] = 'true';
    process.env['VIVA_WEBHOOK_VERIFICATION_KEY'] = VERIFICATION_KEY;

    const DUP_MSG_ID = 'a1a1a1a1-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
    const envelope = buildEnvelope({ MessageId: DUP_MSG_ID });
    const body = Buffer.from(JSON.stringify(envelope));

    // First POST — should insert
    const { req: req1, res: res1, emitted: emitted1 } = makeReqRes({ method: 'POST', ip: '127.0.0.1', rawBody: body });
    await POST(req1, res1 as MedusaResponse);
    expect(emitted1.length).toBe(1);

    // Second POST — same MessageId, should be deduped
    const { req: req2, res: res2, emitted: emitted2 } = makeReqRes({ method: 'POST', ip: '127.0.0.1', rawBody: body });
    await POST(req2, res2 as MedusaResponse);

    // A2: no second emit
    expect(emitted2.length).toBe(0);

    // Still only 1 DB row
    const count = await pool.query(`SELECT COUNT(*) FROM viva_webhook_event WHERE message_id = $1`, [DUP_MSG_ID]);
    expect(Number(count.rows[0]?.count)).toBe(1);
  });

  it.skipIf(!pgReachable)(
    '5. CSO Finding #3: event 7936 is not HMAC-gated (helper kept in core; not subscribed by plugin)',
    async () => {
      // Phase C cleanup: 7936 is not in the subscribed event set and the route
      // no longer attempts HMAC verification with the public verification key.
      // If 7936 is ever subscribed, a dedicated VIVA_WEBHOOK_HMAC_SECRET must
      // be wired in. For now an inbound 7936 envelope is accepted on the
      // normal IP + dedup path (and dropped later as unrecognized event-type).
      process.env['DATABASE_URL'] = connString;
      process.env['VIVA_ENVIRONMENT'] = 'demo';
      process.env['VIVA_WEBHOOK_IP_ALLOWLIST_BYPASS'] = 'true';
      process.env['VIVA_WEBHOOK_VERIFICATION_KEY'] = VERIFICATION_KEY;

      const msgId = 'ffff0000-ffff-ffff-ffff-ffffffffffff';
      const envelope = buildEnvelope({ EventTypeId: 7936, MessageId: msgId });
      const body = Buffer.from(JSON.stringify(envelope));

      // No signature header at all — pre-Phase-C this would have 401'd.
      const { req, res } = makeReqRes({
        method: 'POST',
        ip: '127.0.0.1',
        rawBody: body,
      });

      await POST(req, res as MedusaResponse);

      const data = (res as unknown as { _data: { statusCode?: number } })._data;
      expect(data.statusCode).not.toBe(401);
    },
  );

  it.skipIf(!pgReachable)('7. Non-allowlisted IP: 403, no INSERT', async () => {
    process.env['DATABASE_URL'] = connString;
    process.env['VIVA_ENVIRONMENT'] = 'production'; // production blocklist
    process.env['VIVA_WEBHOOK_IP_ALLOWLIST_BYPASS'] = 'false';
    process.env['VIVA_WEBHOOK_VERIFICATION_KEY'] = VERIFICATION_KEY;

    const envelope = buildEnvelope({ MessageId: '11110000-1111-1111-1111-111111111111' });
    const body = Buffer.from(JSON.stringify(envelope));

    const { req, res } = makeReqRes({
      method: 'POST',
      ip: '8.8.8.8', // Google DNS — definitely not Viva
      rawBody: body,
    });

    await POST(req, res as MedusaResponse);

    const data = (res as unknown as { _data: { statusCode?: number } })._data;
    expect(data.statusCode).toBe(403);

    const count = await pool.query(`SELECT COUNT(*) FROM viva_webhook_event WHERE message_id = $1`, ['11110000-1111-1111-1111-111111111111']);
    expect(Number(count.rows[0]?.count)).toBe(0);

    // Restore
    process.env['VIVA_ENVIRONMENT'] = 'demo';
  });

  it.skipIf(!pgReachable)(
    '7b. CSO Finding #2: leftmost X-Forwarded-For spoof is ignored at default trustedProxyDepth=0',
    async () => {
      process.env['DATABASE_URL'] = connString;
      process.env['VIVA_ENVIRONMENT'] = 'production';
      process.env['VIVA_WEBHOOK_IP_ALLOWLIST_BYPASS'] = 'false';
      process.env['VIVA_WEBHOOK_VERIFICATION_KEY'] = VERIFICATION_KEY;
      delete process.env['VIVA_TRUSTED_PROXY_DEPTH']; // default 0

      const envelope = buildEnvelope({ MessageId: '11110000-2222-3333-4444-555555555555' });
      const body = Buffer.from(JSON.stringify(envelope));

      // Attacker injects a real Viva production IP at the front of X-F-F.
      // At depth=0 the helper ignores X-F-F entirely and uses the socket IP
      // (8.8.8.8) which is NOT in the production allowlist → 403.
      const { req, res } = makeReqRes({
        method: 'POST',
        ip: '8.8.8.8',
        headers: { 'x-forwarded-for': '51.138.37.238' },
        rawBody: body,
      });

      await POST(req, res as MedusaResponse);

      const data = (res as unknown as { _data: { statusCode?: number } })._data;
      expect(data.statusCode).toBe(403);

      const count = await pool.query(
        `SELECT COUNT(*) FROM viva_webhook_event WHERE message_id = $1`,
        ['11110000-2222-3333-4444-555555555555'],
      );
      expect(Number(count.rows[0]?.count)).toBe(0);

      process.env['VIVA_ENVIRONMENT'] = 'demo';
    },
  );

  it.skipIf(!pgReachable)(
    '7c. trustedProxyDepth=1 trusts only the rightmost X-Forwarded-For entry',
    async () => {
      process.env['DATABASE_URL'] = connString;
      process.env['VIVA_ENVIRONMENT'] = 'production';
      process.env['VIVA_WEBHOOK_IP_ALLOWLIST_BYPASS'] = 'false';
      process.env['VIVA_WEBHOOK_VERIFICATION_KEY'] = VERIFICATION_KEY;
      process.env['VIVA_TRUSTED_PROXY_DEPTH'] = '1';

      const envelope = buildEnvelope({ MessageId: '11110000-3333-4444-5555-666666666666' });
      const body = Buffer.from(JSON.stringify(envelope));

      // Attacker puts Viva IP at the front; trusted LB appended an internal IP.
      // depth=1 picks the rightmost (10.0.0.1) → not in allowlist → 403.
      const { req, res } = makeReqRes({
        method: 'POST',
        ip: '8.8.8.8',
        headers: { 'x-forwarded-for': '51.138.37.238, 10.0.0.1' },
        rawBody: body,
      });

      await POST(req, res as MedusaResponse);

      const data = (res as unknown as { _data: { statusCode?: number } })._data;
      expect(data.statusCode).toBe(403);

      delete process.env['VIVA_TRUSTED_PROXY_DEPTH'];
      process.env['VIVA_ENVIRONMENT'] = 'demo';
    },
  );

  it.skipIf(!pgReachable)('8. Unknown MerchantId: INSERT with NULL tenant, metric logged', async () => {
    process.env['DATABASE_URL'] = connString;
    process.env['VIVA_ENVIRONMENT'] = 'demo';
    process.env['VIVA_WEBHOOK_IP_ALLOWLIST_BYPASS'] = 'true';
    process.env['VIVA_WEBHOOK_VERIFICATION_KEY'] = VERIFICATION_KEY;

    const unknownMerchantId = '99999999-9999-9999-9999-999999999999';
    const msgId = '22220000-2222-2222-2222-222222222222';
    const envelope = buildEnvelope({
      MessageId: msgId,
      EventData: {
        TransactionId: TEST_TRANSACTION_ID,
        OrderCode: 99999,
        StatusId: 'F',
        Amount: 1000,
        CurrencyCode: '978',
        MerchantId: unknownMerchantId,
        ConnectedAccountId: null,
        ParentId: null,
        InsDate: new Date().toISOString(),
        TransactionTypeId: 5,
        Email: null,
        FullName: null,
        CardNumber: null,
        CardTypeId: 0,
        MerchantTrns: null,
        CustomerTrns: null,
        SourceCode: 'Default',
        TotalFee: 0,
      },
    });
    const body = Buffer.from(JSON.stringify(envelope));
    const warnMessages: string[] = [];

    const { req, res, emitted } = makeReqRes({ method: 'POST', ip: '127.0.0.1', rawBody: body });
    // Override logger to capture warnings
    (req as unknown as { scope: { resolve: (k: string) => unknown } }).scope.resolve = (key: string) => {
      if (key === 'logger') {
        return {
          info: () => undefined,
          warn: (msg: string) => { warnMessages.push(msg); },
          error: () => undefined,
        };
      }
      if (key === 'event_bus') {
        return {
          emit: async (msg: { name: string; data: Record<string, unknown> }) => {
            emitted.push(msg);
          },
        };
      }
      return null;
    };

    await POST(req, res as MedusaResponse);

    // Row inserted with viva_merchant_id set but no tenant resolution
    const row = await pool.query(`SELECT * FROM viva_webhook_event WHERE message_id = $1`, [msgId]);
    expect(row.rows.length).toBe(1);
    expect(row.rows[0]?.viva_merchant_id).toBe(unknownMerchantId);

    // Event still emitted (subscriber handles reprocess via A6)
    expect(emitted.length).toBe(1);

    // Metric warning was logged
    const hasMetricWarn = warnMessages.some((m) => m.includes('viva_tenant_resolution_failures_total'));
    expect(hasMetricWarn).toBe(true);
  });
});
