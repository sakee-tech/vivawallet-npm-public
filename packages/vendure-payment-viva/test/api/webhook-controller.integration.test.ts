/**
 * test/api/webhook-controller.integration.test.ts — WebhookController replay
 * dedupe against REAL Postgres (issue #1).
 *
 * The INSERT ... ON CONFLICT DO NOTHING runs through a real TypeORM DataSource
 * on a throwaway database. Only the job queue is a spy. A mocked query builder
 * cannot catch this bug: TypeORM fills `identifiers` from the caller-supplied
 * @PrimaryColumn even when Postgres inserted nothing.
 *
 * Deliberately NOT skipIf: an unreachable Postgres fails this suite.
 */

import { describe, it, beforeAll, afterAll, expect, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { DataSource } from 'typeorm';
import { WebhookController } from '../../src/api/webhook.controller.js';
import { VivaWebhookEvent } from '../../src/entities/viva-webhook-event.entity.js';
import type { VivaPaymentPluginOptions } from '../../src/types.js';
import {
  checkPgReachable,
  createTestDatabase,
  dropTestDatabase,
  getTestConnString,
  runMigrationsUp,
} from '../helpers/db.js';

function makeRes() {
  const res = {
    _status: 0,
    _body: '',
    writeHead(s: number) {
      this._status = s;
    },
    end(data?: string) {
      this._body = data ?? '';
    },
  };
  return res as unknown as ServerResponse & { _status: number; _body: string };
}

function makeReq(body: unknown) {
  return {
    body,
    headers: {},
    socket: { remoteAddress: '127.0.0.1' },
  } as unknown as IncomingMessage & { body?: unknown };
}

const options = {
  mode: 'isv',
  clientId: 'test-id',
  clientSecret: 'test-secret',
  onboardingReturnUrl: 'https://example.com/onboarding-return',
  environment: 'demo',
  webhookVerificationKey: 'verify-key-abc',
  successUrl: 'https://example.com/success',
  failureUrl: 'https://example.com/failure',
  webhookIpAllowlist: ['127.0.0.1'],
} as unknown as VivaPaymentPluginOptions;

describe('WebhookController replay dedupe (integration, real Postgres)', () => {
  let dataSource: DataSource;

  beforeAll(async () => {
    if (!(await checkPgReachable())) {
      throw new Error(
        'Postgres unreachable — start it (DATABASE_URL or $USER@localhost:5432) and re-run.',
      );
    }
    await createTestDatabase();
    await runMigrationsUp(getTestConnString());
    dataSource = new DataSource({
      type: 'postgres',
      url: getTestConnString(),
      entities: [VivaWebhookEvent],
    });
    await dataSource.initialize();
  });

  afterAll(async () => {
    await dataSource?.destroy();
    await dropTestDatabase();
  });

  it('same MessageId posted twice → both 200, enqueued exactly once, one row', async () => {
    const add = vi.fn().mockResolvedValue({});
    const jobQueueService = { createQueue: vi.fn().mockResolvedValue({ add }) };
    const ctrl = new WebhookController(
      options,
      { rawConnection: dataSource } as any,
      jobQueueService as any,
    );
    await ctrl.onModuleInit();

    const messageId = randomUUID();
    const body = {
      MessageId: messageId,
      EventTypeId: 1796,
      CorrelationId: 'corr-1',
      RetryCount: 0,
      EventData: { MerchantId: randomUUID(), TransactionId: 'txn-1', Amount: 2000 },
    };

    const first = makeRes();
    await ctrl.handleEvent(makeReq(body), first);
    const replay = makeRes();
    await ctrl.handleEvent(makeReq({ ...body, RetryCount: 1 }), replay);

    expect(first._status).toBe(200);
    expect(replay._status).toBe(200);
    expect(JSON.parse(replay._body)).toEqual({ ok: true });
    expect(add).toHaveBeenCalledTimes(1);
    expect(add).toHaveBeenCalledWith({ messageId });

    const rows = await dataSource.query(
      'SELECT count(*)::int AS n FROM viva_webhook_event WHERE message_id = $1',
      [messageId],
    );
    expect(rows[0].n).toBe(1);
  });
});
