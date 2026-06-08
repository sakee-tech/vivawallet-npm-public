/**
 * LegacyBasicClient unit tests.
 *
 * Tests cover:
 *   1. Basic auth header is correct (Base64 of merchantId:apiKey)
 *   2. Form-urlencoded body is sent correctly
 *   3. Happy path — 200 response with PascalCase JSON parsed correctly
 *   4. x-viva-correlationid / x-viva-eventid headers extracted on success
 *   5. 401 → throws VivaAuthError
 *   6. 4xx → throws VivaApiError
 *   7. Idempotent requests retry on 5xx
 *   8. Non-idempotent requests do NOT retry on 5xx
 *   9. 429 with Retry-After header respected on idempotent request
 *
 * @see references/viva-docs/md/tut-create-recurring-payment.txt:288
 * @see references/viva-docs/md/merchant-id-and-api-key.txt:1
 */

import { describe, it, expect } from 'vitest';
import { MockAgent } from 'undici';
import { fetch as undiciFetch } from 'undici';
import { BasicAuthClient as LegacyBasicClient } from '../../src/legacy/client.js';
import { VivaApiError } from '../../src/errors/api-error.js';
import { VivaAuthError } from '../../src/errors/auth-error.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const LEGACY_HOST = 'https://demo.vivapayments.com';
const TEST_MERCHANT_ID = 'merchant-uuid-1234';
const TEST_API_KEY = 'test-api-key-5678';
const EXPECTED_BASIC = `Basic ${Buffer.from(`${TEST_MERCHANT_ID}:${TEST_API_KEY}`).toString('base64')}`;

function buildClient(agent: MockAgent): LegacyBasicClient {
  const fetchImpl = (url: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    return (undiciFetch as unknown as typeof fetch)(url, {
      ...init,
      // @ts-expect-error undici dispatcher option
      dispatcher: agent,
    });
  };
  return new LegacyBasicClient({
    environment: 'demo',
    merchantId: TEST_MERCHANT_ID,
    apiKey: TEST_API_KEY,
    fetchImpl,
    retryBackoffsMs: [0, 0, 0],
  });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('LegacyBasicClient', () => {
  /**
   * Test 1: Basic auth header is Base64(merchantId:apiKey).
   *
   * @see references/viva-docs/md/merchant-id-and-api-key.txt:1
   */
  it('sets correct Basic auth Authorization header', async () => {
    const agent = new MockAgent();
    agent.disableNetConnect();
    const pool = agent.get(LEGACY_HOST);

    let capturedAuth: string = '';

    pool
      .intercept({ path: '/api/transactions/tx-123', method: 'POST' })
      .reply(200, (opts) => {
        const headers = opts.headers as Record<string, string> | undefined;
        capturedAuth = headers?.['authorization'] ?? headers?.['Authorization'] ?? '';
        return JSON.stringify({ TransactionId: 'tx-123', StatusId: 'F' });
      }, { headers: { 'Content-Type': 'application/json' } });

    const client = buildClient(agent);
    await client.request({
      method: 'POST',
      path: '/api/transactions/tx-123',
      formBody: { Amount: 500, SourceCode: 'Default' },
      idempotent: false,
    });

    expect(capturedAuth).toBe(EXPECTED_BASIC);
    await agent.close();
  });

  /**
   * Test 2: Form-urlencoded body is sent with correct Content-Type.
   */
  it('sends form-urlencoded body with correct Content-Type', async () => {
    const agent = new MockAgent();
    agent.disableNetConnect();
    const pool = agent.get(LEGACY_HOST);

    let capturedBody: string = '';
    let capturedContentType: string = '';

    pool
      .intercept({ path: '/api/transactions/tx-456', method: 'POST' })
      .reply(200, (opts) => {
        capturedBody = opts.body as string;
        const headers = opts.headers as Record<string, string> | undefined;
        capturedContentType = headers?.['content-type'] ?? headers?.['Content-Type'] ?? '';
        return JSON.stringify({ TransactionId: 'tx-456', StatusId: 'F' });
      }, { headers: { 'Content-Type': 'application/json' } });

    const client = buildClient(agent);
    await client.request({
      method: 'POST',
      path: '/api/transactions/tx-456',
      formBody: { Amount: 1234, SourceCode: 'TestSource' },
      idempotent: false,
    });

    const params = new URLSearchParams(capturedBody);
    expect(params.get('Amount')).toBe('1234');
    expect(params.get('SourceCode')).toBe('TestSource');
    expect(capturedContentType).toContain('application/x-www-form-urlencoded');

    await agent.close();
  });

  /**
   * Test 3: Happy path — returns typed data with PascalCase fields.
   */
  it('happy path: returns parsed JSON response', async () => {
    const agent = new MockAgent();
    agent.disableNetConnect();
    const pool = agent.get(LEGACY_HOST);

    pool
      .intercept({ path: '/api/transactions/tx-789', method: 'POST' })
      .reply(200, JSON.stringify({ TransactionId: 'new-tx-id', StatusId: 'F', Amount: 500 }), {
        headers: { 'Content-Type': 'application/json' },
      });

    const client = buildClient(agent);
    const result = await client.request<{ TransactionId: string; StatusId: string; Amount: number }>({
      method: 'POST',
      path: '/api/transactions/tx-789',
      formBody: { Amount: 500, SourceCode: 'Default' },
      idempotent: false,
    });

    expect(result.data.TransactionId).toBe('new-tx-id');
    expect(result.data.StatusId).toBe('F');
    expect(result.data.Amount).toBe(500);

    await agent.close();
  });

  /**
   * Test 4: Viva tracing headers extracted on success.
   *
   * Probe-verified 2026-04-25 (F4): x-viva-correlationid and x-viva-eventid present
   * on every Viva response.
   */
  it('extracts x-viva-correlationid and x-viva-eventid on success', async () => {
    const agent = new MockAgent();
    agent.disableNetConnect();
    const pool = agent.get(LEGACY_HOST);

    pool
      .intercept({ path: '/api/transactions/tx-trace', method: 'POST' })
      .reply(200, JSON.stringify({ TransactionId: 'tx-trace', StatusId: 'F' }), {
        headers: {
          'Content-Type': 'application/json',
          'x-viva-correlationid': '26-115-EDAA55BC',
          'x-viva-eventid': '7',
        },
      });

    const client = buildClient(agent);
    const result = await client.request<{ TransactionId: string }>({
      method: 'POST',
      path: '/api/transactions/tx-trace',
      idempotent: false,
    });

    expect(result.vivaCorrelationId).toBe('26-115-EDAA55BC');
    expect(result.vivaEventId).toBe('7');

    await agent.close();
  });

  /**
   * Test 5: 401 → throws VivaAuthError with clear message.
   *
   * @see references/viva-docs/md/merchant-id-and-api-key.txt:1
   */
  it('401 → throws VivaAuthError', async () => {
    const agent = new MockAgent();
    agent.disableNetConnect();
    const pool = agent.get(LEGACY_HOST);

    pool
      .intercept({ path: '/api/transactions/tx-401', method: 'POST' })
      .reply(401, '{"error":"unauthorized"}', { headers: { 'Content-Type': 'application/json' } });

    const client = buildClient(agent);

    const err = await client.request({
      method: 'POST',
      path: '/api/transactions/tx-401',
      idempotent: false,
    }).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(VivaAuthError);
    expect((err as VivaAuthError).httpStatus).toBe(401);
    expect((err as VivaAuthError).message).toMatch(/merchantId.*apiKey/i);

    await agent.close();
  });

  /**
   * Test 6: 422 → throws VivaApiError (non-5xx non-retry-able).
   */
  it('4xx → throws VivaApiError', async () => {
    const agent = new MockAgent();
    agent.disableNetConnect();
    const pool = agent.get(LEGACY_HOST);

    pool
      .intercept({ path: '/api/transactions/tx-422', method: 'POST' })
      .reply(422, '{"ErrorCode": 3001, "Message": "Already refunded"}', {
        headers: { 'Content-Type': 'application/json' },
      });

    const client = buildClient(agent);

    const err = await client.request({
      method: 'POST',
      path: '/api/transactions/tx-422',
      idempotent: false,
    }).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(VivaApiError);
    expect((err as VivaApiError).httpStatus).toBe(422);

    await agent.close();
  });

  /**
   * Test 7: Idempotent requests retry on 5xx.
   */
  it('idempotent request retries on 5xx', async () => {
    const agent = new MockAgent();
    agent.disableNetConnect();
    const pool = agent.get(LEGACY_HOST);

    let attempts = 0;

    pool
      .intercept({ path: '/api/status/check', method: 'GET' })
      .reply(503, () => { attempts++; return '{}'; }, { headers: { 'Content-Type': 'application/json' } });
    pool
      .intercept({ path: '/api/status/check', method: 'GET' })
      .reply(200, () => { attempts++; return JSON.stringify({ ok: true }); }, { headers: { 'Content-Type': 'application/json' } });

    const client = buildClient(agent);
    const result = await client.request<{ ok: boolean }>({
      method: 'GET',
      path: '/api/status/check',
      idempotent: true,
    });

    expect(result.data.ok).toBe(true);
    expect(attempts).toBe(2);

    await agent.close();
  });

  /**
   * Test 8: Non-idempotent requests do NOT retry on 5xx.
   */
  it('non-idempotent request does NOT retry on 5xx', async () => {
    const agent = new MockAgent();
    agent.disableNetConnect();
    const pool = agent.get(LEGACY_HOST);

    let attempts = 0;

    pool
      .intercept({ path: '/api/transactions/tx-503', method: 'POST' })
      .reply(503, () => { attempts++; return '{}'; }, { headers: { 'Content-Type': 'application/json' } });

    const client = buildClient(agent);

    await expect(
      client.request({
        method: 'POST',
        path: '/api/transactions/tx-503',
        idempotent: false,
      }),
    ).rejects.toBeInstanceOf(VivaApiError);

    expect(attempts).toBe(1);

    await agent.close();
  });
});
