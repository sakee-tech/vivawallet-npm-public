/**
 * IsvWebhooks unit tests.
 *
 * Probe-verified 2026-05-11 against `demo-api.vivapayments.com`.
 * Endpoints + auth scope match the live ISV API:
 *   - POST /isv/v1/webhooks       (Bearer; 204 No Content; body {url, eventTypeId})
 *   - GET  /isv/v1/webhooks/token (Bearer; 200 {key})
 */

import { describe, it, expect } from 'vitest';
import { MockAgent } from 'undici';
import { fetch as undiciFetch } from 'undici';
import { IsvHttpClient } from '../../src/isv/client.js';
import { IsvWebhooks } from '../../src/isv/webhooks-api.js';
import type { AuthStrategy } from '../../src/types/auth.js';

const API_HOST = 'https://demo-api.vivapayments.com';

function makeMockAuthStrategy(): AuthStrategy {
  return {
    name: 'mock',
    async getBearerToken(): Promise<string> {
      return 'test-bearer-token';
    },
  };
}

function buildWebhooks(agent: MockAgent): IsvWebhooks {
  const fetchImpl = (url: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    return (undiciFetch as unknown as typeof fetch)(url, {
      ...init,
      // @ts-expect-error undici dispatcher option
      dispatcher: agent,
    });
  };

  const client = new IsvHttpClient({
    environment: 'demo',
    authStrategy: makeMockAuthStrategy(),
    fetchImpl,
    retryBackoffsMs: [0, 0, 0],
  });

  return new IsvWebhooks(client);
}

describe('IsvWebhooks', () => {
  it('registerWebhook POSTs {eventTypeId, url} to /isv/v1/webhooks and resolves on 204', async () => {
    const agent = new MockAgent();
    agent.disableNetConnect();
    const pool = agent.get(API_HOST);

    let capturedBody: Record<string, unknown> | null = null;
    pool
      .intercept({ path: '/isv/v1/webhooks', method: 'POST' })
      .reply(
        204,
        (opts) => {
          capturedBody = JSON.parse(opts.body as string) as Record<string, unknown>;
          return '';
        },
      );

    const webhooks = buildWebhooks(agent);
    await expect(
      webhooks.registerWebhook({
        eventTypeId: 1796,
        url: 'https://my-platform.com/viva/webhook',
      }),
    ).resolves.toBeUndefined();

    expect(capturedBody).toEqual({
      eventTypeId: 1796,
      url: 'https://my-platform.com/viva/webhook',
    });
    await agent.close();
  });

  it('registerWebhook surfaces the 3732 limit error envelope', async () => {
    const agent = new MockAgent();
    agent.disableNetConnect();
    const pool = agent.get(API_HOST);

    pool
      .intercept({ path: '/isv/v1/webhooks', method: 'POST' })
      .reply(
        400,
        JSON.stringify({
          status: 400,
          message: 'SecurityCreateWebhookFailedLimitReached',
          eventId: 3732,
        }),
        { headers: { 'Content-Type': 'application/json' } },
      );

    const webhooks = buildWebhooks(agent);
    await expect(
      webhooks.registerWebhook({ eventTypeId: 1796, url: 'https://platform.com/viva/webhook' }),
    ).rejects.toMatchObject({
      message: 'SecurityCreateWebhookFailedLimitReached',
    });
    await agent.close();
  });

  it('getVerificationKey GETs /isv/v1/webhooks/token and returns {key}', async () => {
    const agent = new MockAgent();
    agent.disableNetConnect();
    const pool = agent.get(API_HOST);

    pool
      .intercept({ path: '/isv/v1/webhooks/token', method: 'GET' })
      .reply(
        200,
        JSON.stringify({ key: '02599D72473666B072AE8005EC9ADB3772CEB758' }),
        { headers: { 'Content-Type': 'application/json' } },
      );

    const webhooks = buildWebhooks(agent);
    const result = await webhooks.getVerificationKey();

    expect(result.key).toBe('02599D72473666B072AE8005EC9ADB3772CEB758');
    await agent.close();
  });
});
