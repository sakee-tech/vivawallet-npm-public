/**
 * test/api/webhook-controller.test.ts — WebhookController unit tests.
 *
 * Uses a minimal Nest test module (no full Vendure bootstrap required).
 * Mocks: TransactionalConnection, JobQueueService.
 *
 * Covers:
 *  - GET handshake returns {key} from options
 *  - GET handshake when key missing → 503
 *  - POST happy path: row inserted, job enqueued, 200 returned
 *  - POST replay (same messageId twice): second call inserts 0 rows, no enqueue, 200
 *  - POST malformed envelope (missing MessageId) → 400
 *  - POST malformed envelope (missing EventTypeId) → 400
 *  - POST source-IP rejected → 403
 *  - POST source-IP allowlist=false → bypassed, 200
 *  - POST job-queue-throws → still 200 (resilient enqueue)
 *
 * @see docs/plans/vendure-plugin-v0.md §"Build Plan — V6"
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { WebhookController } from '../../src/api/webhook.controller.js';
import type { VivaPaymentPluginOptions } from '../../src/types.js';

// ---------------------------------------------------------------------------
// Helpers — lightweight fakes that avoid the full Vendure DI graph
// ---------------------------------------------------------------------------

/** Build a mock ServerResponse that captures status + body */
function makeMockResponse(): ServerResponse & {
  _status: number;
  _body: string;
  _headers: Record<string, string>;
} {
  let status = 200;
  let body = '';
  const headers: Record<string, string> = {};

  const res = {
    _status: 200,
    _body: '',
    _headers: headers,
    writeHead(s: number, hdrs?: Record<string, string>) {
      status = s;
      if (hdrs) Object.assign(headers, hdrs);
      this._status = status;
    },
    end(data?: string) {
      body = data ?? '';
      this._body = body;
    },
  } as unknown as ServerResponse & {
    _status: number;
    _body: string;
    _headers: Record<string, string>;
  };

  return res;
}

/** Build a mock IncomingMessage with body + optional IP headers */
function makeMockRequest(opts: {
  body?: unknown;
  xForwardedFor?: string;
  xRealIp?: string;
  remoteAddress?: string;
} = {}): IncomingMessage & { body?: unknown } {
  const headers: Record<string, string> = {};
  if (opts.xForwardedFor) headers['x-forwarded-for'] = opts.xForwardedFor;
  if (opts.xRealIp) headers['x-real-ip'] = opts.xRealIp;

  return {
    body: opts.body,
    headers,
    socket: { remoteAddress: opts.remoteAddress ?? '127.0.0.1' },
  } as unknown as IncomingMessage & { body?: unknown };
}

/** Minimal plugin options with a specific allowlist for testing */
function makeOptions(
  overrides: Partial<VivaPaymentPluginOptions & { webhookIpAllowlist: string[] | false }> = {},
): VivaPaymentPluginOptions {
  return {
    mode: 'isv' as const,

    clientId: 'test-id',
    clientSecret: 'test-secret',
    onboardingReturnUrl: 'https://example.com/onboarding-return',
    environment: 'demo',
    webhookVerificationKey: 'verify-key-abc',
    legacyMerchantId: 'test-legacy-merchant-uuid',
    legacyApiKey: 'test-legacy-api-key',
    successUrl: 'https://example.com/success',
    failureUrl: 'https://example.com/failure',
    // Default allowlist contains test source IP so most tests pass IP check.
    webhookIpAllowlist: ['127.0.0.1'],
    ...overrides,
  };
}

/** Build a valid Viva webhook envelope body */
function makeBody(overrides: Partial<{
  MessageId: string;
  EventTypeId: number | null;
  CorrelationId: string;
  RetryCount: number;
  EventData: Record<string, unknown>;
}> = {}): Record<string, unknown> {
  return {
    MessageId: 'msg-uuid-0001',
    EventTypeId: 1796,
    CorrelationId: 'corr-001',
    RetryCount: 0,
    EventData: {
      MerchantId: 'merchant-uuid-0001',
      TransactionId: 'txn-0001',
      Amount: 2000,
    },
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Mock factory for TransactionalConnection
// ---------------------------------------------------------------------------

type InsertBehavior = 'inserted' | 'duplicate';

function makeConnectionMock(behavior: InsertBehavior = 'inserted') {
  const orIgnoreMock = vi.fn().mockReturnThis();
  const executeMock = vi.fn().mockResolvedValue({
    identifiers: behavior === 'inserted' ? [{ messageId: 'msg-uuid-0001' }] : [],
  });

  const queryBuilder = {
    insert: vi.fn().mockReturnThis(),
    into: vi.fn().mockReturnThis(),
    values: vi.fn().mockReturnThis(),
    orIgnore: orIgnoreMock,
    execute: executeMock,
  };

  const repo = {
    createQueryBuilder: vi.fn().mockReturnValue(queryBuilder),
  };

  const conn = {
    rawConnection: {
      getRepository: vi.fn().mockReturnValue(repo),
    },
  };

  return { conn, repo, queryBuilder, executeMock, orIgnoreMock };
}

// ---------------------------------------------------------------------------
// Mock factory for JobQueueService
// ---------------------------------------------------------------------------

function makeJobQueueMock(addBehavior: 'ok' | 'throw' = 'ok') {
  const addMock = vi.fn();

  if (addBehavior === 'throw') {
    addMock.mockRejectedValue(new Error('Redis connection failed'));
  } else {
    addMock.mockResolvedValue({});
  }

  const queue = { add: addMock };
  const createQueueMock = vi.fn().mockResolvedValue(queue);

  const jobQueueService = { createQueue: createQueueMock };

  return { jobQueueService, queue, addMock, createQueueMock };
}

// ---------------------------------------------------------------------------
// Controller factory
// ---------------------------------------------------------------------------

async function buildController(
  options: VivaPaymentPluginOptions,
  behavior: InsertBehavior = 'inserted',
  addBehavior: 'ok' | 'throw' = 'ok',
) {
  const { conn } = makeConnectionMock(behavior);
  const { jobQueueService, addMock } = makeJobQueueMock(addBehavior);

  const ctrl = new WebhookController(
    options,
    conn as any,
    jobQueueService as any,
  );

  // Simulate Nest's onModuleInit lifecycle
  await ctrl.onModuleInit();

  return { ctrl, addMock };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('WebhookController', () => {
  beforeEach(() => {
    vi.spyOn(console, 'warn').mockReturnValue(undefined);
    vi.spyOn(console, 'info').mockReturnValue(undefined);
    vi.spyOn(console, 'error').mockReturnValue(undefined);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // -------------------------------------------------------------------------
  // GET /viva/webhook — URL verification
  // -------------------------------------------------------------------------

  describe('GET /viva/webhook — URL-verification handshake', () => {
    it('returns {Key} from options (documented capital-K shape)', async () => {
      const { ctrl } = await buildController(makeOptions());
      const res = makeMockResponse();

      ctrl.handleVerification(res);

      expect(res._status).toBe(200);
      expect(JSON.parse(res._body)).toEqual({ Key: 'verify-key-abc' });
    });

    it('returns 503 when webhookVerificationKey is missing', async () => {
      const { ctrl } = await buildController(
        makeOptions({ webhookVerificationKey: '' }),
      );
      const res = makeMockResponse();

      ctrl.handleVerification(res);

      expect(res._status).toBe(503);
      expect(JSON.parse(res._body)).toEqual({ error: 'webhook key not configured' });
    });
  });

  // -------------------------------------------------------------------------
  // POST /viva/webhook — Happy path
  // -------------------------------------------------------------------------

  describe('POST /viva/webhook — happy path', () => {
    it('inserts row, enqueues job, returns 200 {ok:true}', async () => {
      const { ctrl, addMock } = await buildController(makeOptions(), 'inserted');

      const req = makeMockRequest({ body: makeBody(), remoteAddress: '127.0.0.1' });
      const res = makeMockResponse();

      await ctrl.handleEvent(req, res);

      expect(res._status).toBe(200);
      expect(JSON.parse(res._body)).toEqual({ ok: true });
      expect(addMock).toHaveBeenCalledTimes(1);
      expect(addMock).toHaveBeenCalledWith({ messageId: 'msg-uuid-0001' });
    });
  });

  // -------------------------------------------------------------------------
  // POST /viva/webhook — envelope field mapping
  // -------------------------------------------------------------------------

  describe('POST /viva/webhook — inserted row field mapping', () => {
    it('maps EventData.ConnectedAccountId → accountId and forces retryCount=0', async () => {
      const { conn, queryBuilder } = makeConnectionMock('inserted');
      const { jobQueueService } = makeJobQueueMock('ok');
      const ctrl = new WebhookController(makeOptions(), conn as any, jobQueueService as any);
      await ctrl.onModuleInit();

      const req = makeMockRequest({
        remoteAddress: '127.0.0.1',
        body: makeBody({
          EventTypeId: 8194,
          // Viva's real onboarding field name — NOT `AccountId`.
          EventData: { ConnectedAccountId: 'acct-uuid-0007', MerchantId: 'merchant-uuid-0001' },
          // Viva's DELIVERY retry count must NOT seed the internal counter.
          RetryCount: 5,
        }),
      });
      const res = makeMockResponse();

      await ctrl.handleEvent(req, res);

      const inserted = queryBuilder.values.mock.calls[0]![0] as Record<string, unknown>;
      expect(inserted.accountId).toBe('acct-uuid-0007');
      expect(inserted.retryCount).toBe(0);
    });

    it('accountId is null when no ConnectedAccountId present (and never reads AccountId)', async () => {
      const { conn, queryBuilder } = makeConnectionMock('inserted');
      const { jobQueueService } = makeJobQueueMock('ok');
      const ctrl = new WebhookController(makeOptions(), conn as any, jobQueueService as any);
      await ctrl.onModuleInit();

      const req = makeMockRequest({
        remoteAddress: '127.0.0.1',
        // A stray `AccountId` must be ignored — only ConnectedAccountId counts.
        body: makeBody({ EventData: { AccountId: 'should-be-ignored', MerchantId: 'm' } }),
      });
      await ctrl.handleEvent(req, makeMockResponse());

      const inserted = queryBuilder.values.mock.calls[0]![0] as Record<string, unknown>;
      expect(inserted.accountId).toBeNull();
    });
  });

  // -------------------------------------------------------------------------
  // POST /viva/webhook — Replay dedup
  // -------------------------------------------------------------------------

  describe('POST /viva/webhook — replay deduplication', () => {
    it('second call with same messageId: 0 rows inserted, job NOT enqueued, still 200', async () => {
      const { ctrl, addMock } = await buildController(makeOptions(), 'duplicate');

      const req = makeMockRequest({ body: makeBody(), remoteAddress: '127.0.0.1' });
      const res = makeMockResponse();

      await ctrl.handleEvent(req, res);

      expect(res._status).toBe(200);
      expect(JSON.parse(res._body)).toEqual({ ok: true });
      // Job must NOT be enqueued for a replay.
      expect(addMock).not.toHaveBeenCalled();
    });
  });

  // -------------------------------------------------------------------------
  // POST /viva/webhook — Malformed envelope
  // -------------------------------------------------------------------------

  describe('POST /viva/webhook — malformed envelope', () => {
    it('missing MessageId → 400', async () => {
      const { ctrl } = await buildController(makeOptions());

      const body = makeBody();
      delete body['MessageId'];

      const req = makeMockRequest({ body, remoteAddress: '127.0.0.1' });
      const res = makeMockResponse();

      await ctrl.handleEvent(req, res);

      expect(res._status).toBe(400);
      expect(JSON.parse(res._body)).toEqual({ error: 'malformed envelope' });
    });

    it('empty MessageId string → 400', async () => {
      const { ctrl } = await buildController(makeOptions());

      const req = makeMockRequest({ body: makeBody({ MessageId: '' }), remoteAddress: '127.0.0.1' });
      const res = makeMockResponse();

      await ctrl.handleEvent(req, res);

      expect(res._status).toBe(400);
      expect(JSON.parse(res._body)).toEqual({ error: 'malformed envelope' });
    });

    it('missing EventTypeId → 400', async () => {
      const { ctrl } = await buildController(makeOptions());

      const body = makeBody();
      delete body['EventTypeId'];

      const req = makeMockRequest({ body, remoteAddress: '127.0.0.1' });
      const res = makeMockResponse();

      await ctrl.handleEvent(req, res);

      expect(res._status).toBe(400);
      expect(JSON.parse(res._body)).toEqual({ error: 'malformed envelope' });
    });

    it('null EventTypeId → 400', async () => {
      const { ctrl } = await buildController(makeOptions());

      const req = makeMockRequest({
        body: makeBody({ EventTypeId: null as any }),
        remoteAddress: '127.0.0.1',
      });
      const res = makeMockResponse();

      await ctrl.handleEvent(req, res);

      expect(res._status).toBe(400);
      expect(JSON.parse(res._body)).toEqual({ error: 'malformed envelope' });
    });
  });

  // -------------------------------------------------------------------------
  // POST /viva/webhook — IP allowlist
  // -------------------------------------------------------------------------

  describe('POST /viva/webhook — IP allowlist', () => {
    it('source IP not in allowlist → 403', async () => {
      const { ctrl } = await buildController(
        makeOptions({ webhookIpAllowlist: ['10.0.0.1'] }),
      );

      const req = makeMockRequest({
        body: makeBody(),
        remoteAddress: '1.2.3.4', // not in allowlist
      });
      const res = makeMockResponse();

      await ctrl.handleEvent(req, res);

      expect(res._status).toBe(403);
      expect(JSON.parse(res._body)).toEqual({ error: 'forbidden' });
    });

    it('source IP matches CIDR in allowlist → 200', async () => {
      const { ctrl } = await buildController(
        makeOptions({ webhookIpAllowlist: ['10.0.0.0/24'] }),
      );

      const req = makeMockRequest({
        body: makeBody(),
        remoteAddress: '10.0.0.50',
      });
      const res = makeMockResponse();

      await ctrl.handleEvent(req, res);

      expect(res._status).toBe(200);
    });

    it('allowlist=false (disabled) → IP not checked, 200 returned', async () => {
      const { ctrl, addMock } = await buildController(
        makeOptions({ webhookIpAllowlist: false as any }),
      );

      const req = makeMockRequest({
        body: makeBody(),
        remoteAddress: '99.99.99.99', // would fail if allowlist were active
      });
      const res = makeMockResponse();

      await ctrl.handleEvent(req, res);

      expect(res._status).toBe(200);
      expect(addMock).toHaveBeenCalledTimes(1);
    });

    it('ignores X-Forwarded-For by default (trustedProxyDepth=0); uses socket', async () => {
      // CSO Finding #2: leftmost-XFF trust was the bug. With no proxy configured,
      // the helper now ignores XFF entirely and falls back to socket. Attacker
      // header injection no longer satisfies the allowlist.
      const { ctrl } = await buildController(
        makeOptions({ webhookIpAllowlist: ['10.0.0.1'] }),
      );

      const req = makeMockRequest({
        body: makeBody(),
        xForwardedFor: '192.168.1.100, 10.0.0.1', // attacker-claim + LB-set
        remoteAddress: '10.0.0.1',
      });
      const res = makeMockResponse();

      await ctrl.handleEvent(req, res);

      // Socket IP 10.0.0.1 is in allowlist → 200. The XFF leftmost (192.168.1.100)
      // is never consulted.
      expect(res._status).toBe(200);
    });

    it('with trustedProxyDepth=1, picks rightmost X-Forwarded-For (LB-set) entry', async () => {
      const { ctrl } = await buildController(
        makeOptions({
          webhookIpAllowlist: ['51.138.37.238'],
          trustedProxyDepth: 1,
        }),
      );

      const req = makeMockRequest({
        body: makeBody(),
        // Attacker claims a Viva IP at the front; LB appended the real one.
        xForwardedFor: '192.168.1.100, 51.138.37.238',
        remoteAddress: '10.0.0.1',
      });
      const res = makeMockResponse();

      await ctrl.handleEvent(req, res);

      expect(res._status).toBe(200);
    });

    it('with trustedProxyDepth=1, rejects leftmost-spoofed Viva IP', async () => {
      // The classic exploit: attacker injects a Viva IP in the leftmost slot.
      // With depth=1, only the rightmost entry is trusted, so the spoof fails.
      const { ctrl } = await buildController(
        makeOptions({
          webhookIpAllowlist: ['51.138.37.238'],
          trustedProxyDepth: 1,
        }),
      );

      const req = makeMockRequest({
        body: makeBody(),
        xForwardedFor: '51.138.37.238, 192.168.1.100',
        remoteAddress: '10.0.0.1',
      });
      const res = makeMockResponse();

      await ctrl.handleEvent(req, res);

      expect(res._status).toBe(403);
    });
  });

  // -------------------------------------------------------------------------
  // POST /viva/webhook — Resilient enqueue
  // -------------------------------------------------------------------------

  describe('POST /viva/webhook — resilient enqueue', () => {
    it('job queue throws → still returns 200 (row was persisted)', async () => {
      const { ctrl } = await buildController(makeOptions(), 'inserted', 'throw');

      const req = makeMockRequest({ body: makeBody(), remoteAddress: '127.0.0.1' });
      const res = makeMockResponse();

      // Must NOT throw
      await expect(ctrl.handleEvent(req, res)).resolves.toBeUndefined();

      expect(res._status).toBe(200);
      expect(JSON.parse(res._body)).toEqual({ ok: true });
    });
  });
});
