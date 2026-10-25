/**
 * BasicAuthClient.fetchWebhookVerificationKey() — unit tests.
 *
 * Covers the merchant-mode helper used by `viva-register-webhooks --apply`:
 *   - Happy path with `{ Key }` (Pascal-case, per Viva docs)
 *   - Tolerant lower-case `{ key }` (canonicality unverified, see §8.1)
 *   - Missing key field → VivaApiError
 *
 * @see docs/ENDPOINTS.md §8.1
 * @see references/viva-docs/md/webhooks-for-payments.txt:311
 */

import { describe, it, expect } from 'vitest';
import { MockAgent } from 'undici';
import { fetch as undiciFetch } from 'undici';
import { BasicAuthClient } from '../../src/legacy/client.js';
import { VivaApiError } from '../../src/errors/index.js';

const LEGACY_HOST = 'https://demo.vivapayments.com';
const MERCHANT_ID = 'merchant-uuid-aaaa';
const API_KEY = 'merchant-api-key-bbbb';

function fetchVia(agent: MockAgent): typeof fetch {
  return (url: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    return (undiciFetch as unknown as typeof fetch)(url, {
      ...init,
      // @ts-expect-error undici dispatcher option
      dispatcher: agent,
    });
  };
}

describe('BasicAuthClient.fetchWebhookVerificationKey()', () => {
  it('returns the verification key from `{ Key }` (PascalCase, per Viva docs)', async () => {
    const agent = new MockAgent();
    agent.disableNetConnect();
    const pool = agent.get(LEGACY_HOST);

    pool
      .intercept({ path: '/api/messages/config/token', method: 'GET' })
      .reply(200, JSON.stringify({ Key: 'merchant-wvk-pascal' }), {
        headers: { 'Content-Type': 'application/json' },
      });

    const client = new BasicAuthClient({
      environment: 'demo',
      merchantId: MERCHANT_ID,
      apiKey: API_KEY,
      fetchImpl: fetchVia(agent),
      retryBackoffsMs: [0, 0, 0],
    });

    const key = await client.fetchWebhookVerificationKey();
    expect(key).toBe('merchant-wvk-pascal');
    await agent.close();
  });

  it('tolerates lower-case `{ key }` (canonicality unverified, see §8.1)', async () => {
    const agent = new MockAgent();
    agent.disableNetConnect();
    const pool = agent.get(LEGACY_HOST);

    pool
      .intercept({ path: '/api/messages/config/token', method: 'GET' })
      .reply(200, JSON.stringify({ key: 'merchant-wvk-lower' }), {
        headers: { 'Content-Type': 'application/json' },
      });

    const client = new BasicAuthClient({
      environment: 'demo',
      merchantId: MERCHANT_ID,
      apiKey: API_KEY,
      fetchImpl: fetchVia(agent),
      retryBackoffsMs: [0, 0, 0],
    });

    const key = await client.fetchWebhookVerificationKey();
    expect(key).toBe('merchant-wvk-lower');
    await agent.close();
  });

  it('throws VivaApiError when the response has no Key/key field', async () => {
    const agent = new MockAgent();
    agent.disableNetConnect();
    const pool = agent.get(LEGACY_HOST);

    pool
      .intercept({ path: '/api/messages/config/token', method: 'GET' })
      .reply(200, JSON.stringify({ unrelated: 'value' }), {
        headers: { 'Content-Type': 'application/json' },
      });

    const client = new BasicAuthClient({
      environment: 'demo',
      merchantId: MERCHANT_ID,
      apiKey: API_KEY,
      fetchImpl: fetchVia(agent),
      retryBackoffsMs: [0, 0, 0],
    });

    await expect(client.fetchWebhookVerificationKey()).rejects.toBeInstanceOf(
      VivaApiError,
    );
    await agent.close();
  });
});
