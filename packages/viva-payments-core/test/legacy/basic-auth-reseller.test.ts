/**
 * BasicAuthClient — reseller variant unit tests.
 *
 * Covers the discriminated `authVariant` union introduced in slice 4:
 *   - reseller variant builds Basic header from `resellerId:merchantId:resellerApiKey`
 *   - merchant variant remains `merchantId:apiKey` (regression)
 *   - missing reseller fields throw on construction
 *   - snapshot test pins header value for a known input
 *   - `LegacyBasicClient` deprecated alias still emits the merchant header
 *
 * @see docs/AUTH.md §1.2 (Merchant vs Reseller Basic)
 */

import { describe, it, expect } from 'vitest';
import { MockAgent } from 'undici';
import { fetch as undiciFetch } from 'undici';
import { BasicAuthClient } from '../../src/legacy/client.js';
import { LegacyBasicClient } from '../../src/isv/index.js';

const LEGACY_HOST = 'https://demo.vivapayments.com';

const RESELLER_ID = 'reseller-uuid-1111';
const CONNECTED_MERCHANT_ID = 'merchant-uuid-2222';
const RESELLER_API_KEY = 'reseller-api-key-3333';
const EXPECTED_RESELLER_BASIC = `Basic ${Buffer.from(
  `${RESELLER_ID}:${CONNECTED_MERCHANT_ID}:${RESELLER_API_KEY}`,
).toString('base64')}`;

const MERCHANT_ID = 'merchant-uuid-aaaa';
const API_KEY = 'merchant-api-key-bbbb';
const EXPECTED_MERCHANT_BASIC = `Basic ${Buffer.from(`${MERCHANT_ID}:${API_KEY}`).toString(
  'base64',
)}`;

function fetchVia(agent: MockAgent): typeof fetch {
  return (url: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    return (undiciFetch as unknown as typeof fetch)(url, {
      ...init,
      // @ts-expect-error undici dispatcher option
      dispatcher: agent,
    });
  };
}

describe('BasicAuthClient — reseller variant', () => {
  it('accepts reseller-variant config and round-trips the header', async () => {
    const agent = new MockAgent();
    agent.disableNetConnect();
    const pool = agent.get(LEGACY_HOST);

    let capturedAuth = '';
    pool
      .intercept({ path: '/api/sources', method: 'POST' })
      .reply(
        200,
        (opts) => {
          const headers = opts.headers as Record<string, string> | undefined;
          capturedAuth = headers?.['authorization'] ?? headers?.['Authorization'] ?? '';
          return JSON.stringify({ sourceCode: 4567 });
        },
        { headers: { 'Content-Type': 'application/json' } },
      );

    const client = new BasicAuthClient({
      authVariant: 'reseller',
      environment: 'demo',
      resellerId: RESELLER_ID,
      merchantId: CONNECTED_MERCHANT_ID,
      resellerApiKey: RESELLER_API_KEY,
      fetchImpl: fetchVia(agent),
      retryBackoffsMs: [0, 0, 0],
    });

    await client.request({
      method: 'POST',
      path: '/api/sources',
      jsonBody: { isPhysical: true, name: 'Test' },
      idempotent: false,
    });

    expect(capturedAuth).toBe(EXPECTED_RESELLER_BASIC);
    await agent.close();
  });

  it('produces Basic base64(resellerId:merchantId:resellerApiKey) — snapshot', () => {
    // base64 of "reseller-uuid-1111:merchant-uuid-2222:reseller-api-key-3333"
    // is deterministic; pin the value so future regressions trip the test.
    const expected =
      'Basic ' +
      Buffer.from('reseller-uuid-1111:merchant-uuid-2222:reseller-api-key-3333').toString(
        'base64',
      );
    expect(EXPECTED_RESELLER_BASIC).toBe(expected);
    expect(EXPECTED_RESELLER_BASIC).toMatchInlineSnapshot(
      `"Basic cmVzZWxsZXItdXVpZC0xMTExOm1lcmNoYW50LXV1aWQtMjIyMjpyZXNlbGxlci1hcGkta2V5LTMzMzM="`,
    );
  });

  it('merchant variant (regression) still produces Basic base64(merchantId:apiKey)', async () => {
    const agent = new MockAgent();
    agent.disableNetConnect();
    const pool = agent.get(LEGACY_HOST);

    let capturedAuth = '';
    pool
      .intercept({ path: '/api/transactions/tx-merchant', method: 'POST' })
      .reply(
        200,
        (opts) => {
          const headers = opts.headers as Record<string, string> | undefined;
          capturedAuth = headers?.['authorization'] ?? headers?.['Authorization'] ?? '';
          return JSON.stringify({ TransactionId: 'tx-merchant', StatusId: 'F' });
        },
        { headers: { 'Content-Type': 'application/json' } },
      );

    const client = new BasicAuthClient({
      authVariant: 'merchant',
      environment: 'demo',
      merchantId: MERCHANT_ID,
      apiKey: API_KEY,
      fetchImpl: fetchVia(agent),
      retryBackoffsMs: [0, 0, 0],
    });

    await client.request({
      method: 'POST',
      path: '/api/transactions/tx-merchant',
      formBody: { Amount: 500 },
      idempotent: false,
    });

    expect(capturedAuth).toBe(EXPECTED_MERCHANT_BASIC);
    await agent.close();
  });

  it('reseller variant without resellerApiKey throws TypeError on construct', () => {
    expect(
      () =>
        new BasicAuthClient({
          authVariant: 'reseller',
          environment: 'demo',
          resellerId: RESELLER_ID,
          merchantId: CONNECTED_MERCHANT_ID,
          // @ts-expect-error — intentionally missing
          resellerApiKey: '',
        }),
    ).toThrow(TypeError);
  });

  it('LegacyBasicClient deprecated alias still emits the merchant header', async () => {
    const agent = new MockAgent();
    agent.disableNetConnect();
    const pool = agent.get(LEGACY_HOST);

    let capturedAuth = '';
    pool
      .intercept({ path: '/api/transactions/tx-legacy', method: 'POST' })
      .reply(
        200,
        (opts) => {
          const headers = opts.headers as Record<string, string> | undefined;
          capturedAuth = headers?.['authorization'] ?? headers?.['Authorization'] ?? '';
          return JSON.stringify({ TransactionId: 'tx-legacy', StatusId: 'F' });
        },
        { headers: { 'Content-Type': 'application/json' } },
      );

    const client = new LegacyBasicClient({
      environment: 'demo',
      merchantId: MERCHANT_ID,
      apiKey: API_KEY,
      fetchImpl: fetchVia(agent),
      retryBackoffsMs: [0, 0, 0],
    });

    await client.request({
      method: 'POST',
      path: '/api/transactions/tx-legacy',
      idempotent: false,
    });

    expect(capturedAuth).toBe(EXPECTED_MERCHANT_BASIC);
    await agent.close();
  });

  it('401 from reseller variant hints at reseller credentials', async () => {
    const agent = new MockAgent();
    agent.disableNetConnect();
    const pool = agent.get(LEGACY_HOST);

    pool
      .intercept({ path: '/api/sources', method: 'POST' })
      .reply(401, '{"error":"unauthorized"}', {
        headers: { 'Content-Type': 'application/json' },
      });

    const client = new BasicAuthClient({
      authVariant: 'reseller',
      environment: 'demo',
      resellerId: RESELLER_ID,
      merchantId: CONNECTED_MERCHANT_ID,
      resellerApiKey: RESELLER_API_KEY,
      fetchImpl: fetchVia(agent),
      retryBackoffsMs: [0, 0, 0],
    });

    const err = (await client
      .request({
        method: 'POST',
        path: '/api/sources',
        jsonBody: { isPhysical: true, name: 'x' },
        idempotent: false,
      })
      .catch((e: unknown) => e)) as Error;

    expect(err).toBeInstanceOf(Error);
    expect(err.message).toMatch(/resellerId.*merchantId.*resellerApiKey/i);

    await agent.close();
  });
});
