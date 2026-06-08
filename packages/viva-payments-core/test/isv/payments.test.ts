/**
 * IsvPayments unit tests.
 *
 * All HTTP is intercepted by undici MockAgent — no live network.
 *
 * Tests cover:
 *   1.  createOrder happy path: validates, sets Idempotency-Key header, returns OrderCode
 *   2.  createOrder rejects amountMinor <= 0 with VivaValidationError (no HTTP call)
 *   2b. createOrder rejects invalid currencyCode
 *   3.  retrieveTransaction returns full transaction with bigint OrderCode preserved
 *   4.  refundPayment (partial) → POSTs to LEGACY HOST with form-encoded Amount
 *   4b. refundPayment (full) → POSTs to LEGACY HOST with no Amount in form body
 *   4c. refundPayment — no legacyClient → throws VivaValidationError
 *   4d. refundPayment — 404 from legacy host → throws VivaApiError
 *   4e. refundPayment — 4xx from legacy host → throws VivaApiError (no retry for non-idempotent)
 *   5.  cancelOrder is treated as idempotent (retries 5xx)
 *   5b. refundPayment (non-idempotent) does NOT retry on 5xx
 *   6+. 401 → reseller fallback for cancelOrder, retrieveTransaction (D15)
 *   NEW. x-viva-correlationid / x-viva-eventid extracted from IsvHttpClient responses
 *
 * NOTE: refundPayment 401-fallback tests have been REMOVED. Per probe F1 (2026-04-25),
 * Viva returns 405 (not 401) on `POST /checkout/v2/transactions/{id}`. The fallback
 * never triggers. refundPayment now calls the legacy client DIRECTLY — there is no
 * v2 attempt to fall back from. The 401-fallback tests for cancelOrder and
 * retrieveTransaction are retained (those are still on the v2/OAuth2 path).
 *
 * @see references/viva-docs/md/payment-isv-api.txt:1
 * @see references/viva-docs/md/webhooks-for-payments.txt:248
 * @see references/viva-docs/md/isv-partner-program.txt:296
 * @see references/viva-docs/md/isv-credentials.txt:107 (reseller credentials)
 * @see references/viva-docs/md/tut-create-recurring-payment.txt:288 (legacy refund path)
 * @see docs/plans/vendure-plugin-v0.md §D15 (reseller fallback scope)
 */

import { describe, it, expect } from 'vitest';
import { MockAgent } from 'undici';
import { fetch as undiciFetch } from 'undici';
import { IsvHttpClient } from '../../src/isv/client.js';
import { BasicAuthClient as LegacyBasicClient } from '../../src/legacy/client.js';
import { IsvPayments } from '../../src/isv/index.js';
import { VivaValidationError } from '../../src/errors/validation-error.js';
import { VivaApiError } from '../../src/errors/api-error.js';
import { VivaAuthError } from '../../src/errors/auth-error.js';
import type { AuthStrategy } from '../../src/types/auth.js';
import type { MerchantId, TransactionId } from '../../src/types/common.js';
import { asCurrencyCode, CURRENCY_CODES } from '../../src/types/common.js';

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

const API_HOST = 'https://demo-api.vivapayments.com';
const LEGACY_HOST = 'https://demo.vivapayments.com';
const TEST_MERCHANT_ID = 'merchant-uuid-1234' as MerchantId;
const TEST_API_KEY = 'test-api-key-5678';
const TEST_TRANSACTION_ID = 'tx-uuid-5678' as TransactionId;

function makeMockAuthStrategy(): AuthStrategy {
  return {
    name: 'mock',
    async getBearerToken(): Promise<string> {
      return 'test-bearer-token';
    },
  };
}

function buildPayments(agent: MockAgent): IsvPayments {
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

  return new IsvPayments(client);
}

/**
 * Build an IsvPayments with both OAuth2 primary client and a LegacyBasicClient.
 * Both share the same MockAgent so tests can intercept both hosts.
 */
function buildPaymentsWithLegacy(agent: MockAgent): IsvPayments {
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

  const legacyClient = new LegacyBasicClient({
    environment: 'demo',
    merchantId: TEST_MERCHANT_ID,
    apiKey: TEST_API_KEY,
    fetchImpl,
    retryBackoffsMs: [0, 0, 0],
  });

  return new IsvPayments(client, undefined, legacyClient);
}

/**
 * Build an IsvPayments with both primary and secondary (reseller) OAuth2 clients
 * sharing the same MockAgent. Used for 401-fallback tests on cancelOrder / retrieveTransaction.
 *
 * @see docs/plans/vendure-plugin-v0.md §D15
 */
function buildPaymentsWithSecondary(agent: MockAgent): IsvPayments {
  const fetchImpl = (url: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    return (undiciFetch as unknown as typeof fetch)(url, {
      ...init,
      // @ts-expect-error undici dispatcher option
      dispatcher: agent,
    });
  };

  const primaryClient = new IsvHttpClient({
    environment: 'demo',
    authStrategy: makeMockAuthStrategy(),
    fetchImpl,
    retryBackoffsMs: [0, 0, 0],
  });

  const secondaryClient = new IsvHttpClient({
    environment: 'demo',
    authStrategy: {
      name: 'reseller-basic-auth',
      async getBearerToken(): Promise<string> {
        return 'reseller-bearer-token';
      },
    },
    fetchImpl,
    retryBackoffsMs: [0, 0, 0],
  });

  return new IsvPayments(primaryClient, secondaryClient);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('IsvPayments', () => {
  /**
   * Test 1: createOrder happy path.
   * - Validates amount > 0 and currencyCode
   * - Sets Idempotency-Key header (note: Viva does NOT server-side dedupe — F2)
   * - Returns orderCode as bigint
   *
   * @see references/viva-docs/md/payment-isv-api.txt:1
   * @see references/viva-docs/md/isv-partner-program.txt:61 (P14 idempotency)
   */
  it('createOrder happy path: validates, sets Idempotency-Key, returns orderCode', async () => {
    const agent = new MockAgent();
    agent.disableNetConnect();
    const pool = agent.get(API_HOST);

    let capturedIdempotencyKey: string | null = null;
    let capturedBody: unknown = null;

    pool
      .intercept({ path: '/checkout/v2/isv/orders?merchantId=merchant-uuid-1234', method: 'POST' })
      .reply(
        200,
        (opts) => {
          // MockAgent normalizes header names to lowercase
          const headers = opts.headers as Record<string, string> | undefined;
          capturedIdempotencyKey =
            headers?.['idempotency-key'] ??
            headers?.['Idempotency-Key'] ??
            null;
          capturedBody = JSON.parse(opts.body as string);
          // Real Viva checkout/v2 response shape: lowercase `orderCode`
          // (verified live + OpenAPI). #9.
          return JSON.stringify({ orderCode: 9876543210 });
        },
        { headers: { 'Content-Type': 'application/json' } },
      );

    const payments = buildPayments(agent);
    const result = await payments.createOrder(
      {
        amount: 1234n,
        currencyCode: CURRENCY_CODES.EUR,
        merchantTrns: 'order-ref-123',
      },
      {
        merchantId: TEST_MERCHANT_ID,
        idempotencyKey: 'medusa-payment-abc-123',
      },
    );

    expect(result.orderCode).toBe(9876543210n);
    expect(capturedIdempotencyKey).toBe('medusa-payment-abc-123');
    expect(capturedBody).toMatchObject({ amount: 1234, merchantTrns: 'order-ref-123' });
    await agent.close();
  });

  /**
   * Test 1b (#9 regression): createOrder must read the order code regardless of
   * response key casing. Viva's modern create-order returns lowercase
   * `orderCode`; older/legacy envelopes use PascalCase `OrderCode`. Reading only
   * `OrderCode` silently dropped the code on every real (lowercase) response,
   * returning `{ orderCode: undefined }` and orphaning the order on Viva.
   */
  it.each([
    ['lowercase orderCode (real Viva checkout/v2 shape)', { orderCode: 3144322017902375 }],
    ['PascalCase OrderCode (legacy envelope)', { OrderCode: 3144322017902375 }],
  ])('createOrder reads the code from %s', async (_label, body) => {
    const agent = new MockAgent();
    agent.disableNetConnect();
    const pool = agent.get(API_HOST);
    pool
      .intercept({ path: /\/checkout\/v2\/isv\/orders/, method: 'POST' })
      .reply(200, JSON.stringify(body), { headers: { 'Content-Type': 'application/json' } });

    const payments = buildPayments(agent);
    const result = await payments.createOrder(
      { amount: 1399n, currencyCode: CURRENCY_CODES.EUR },
      { merchantId: TEST_MERCHANT_ID, idempotencyKey: 'k' },
    );

    expect(result.orderCode).toBe(3144322017902375n);
    await agent.close();
  });

  /**
   * Test 2: createOrder rejects amountMinor <= 0 with VivaValidationError.
   * No HTTP call should be made.
   *
   * @see references/viva-docs/md/isv-partner-program.txt:83 (P15 amounts)
   */
  it('createOrder rejects amountMinor <= 0 with VivaValidationError (no HTTP call)', async () => {
    const agent = new MockAgent();
    agent.disableNetConnect();
    // No interceptors registered — any HTTP call would throw

    const payments = buildPayments(agent);

    await expect(
      payments.createOrder(
        { amount: 0n, currencyCode: CURRENCY_CODES.EUR },
        { merchantId: TEST_MERCHANT_ID, idempotencyKey: 'key-1' },
      ),
    ).rejects.toSatisfy((err: unknown) => {
      expect(err).toBeInstanceOf(VivaValidationError);
      expect((err as VivaValidationError).code).toBe('VIVA_VALIDATION_ERROR');
      return true;
    });

    await expect(
      payments.createOrder(
        { amount: -100n, currencyCode: CURRENCY_CODES.EUR },
        { merchantId: TEST_MERCHANT_ID, idempotencyKey: 'key-2' },
      ),
    ).rejects.toBeInstanceOf(VivaValidationError);

    // Confirm no HTTP calls were attempted
    // (MockAgent would throw on disableNetConnect if any call was made)
    await agent.close();
  });

  /**
   * Test 2b: createOrder rejects invalid currencyCode.
   *
   * @see references/viva-docs/md/webhooks-for-payments.txt:487
   */
  it('createOrder rejects invalid currencyCode with VivaValidationError', async () => {
    const agent = new MockAgent();
    agent.disableNetConnect();

    const payments = buildPayments(agent);

    await expect(
      payments.createOrder(
        { amount: 1000n, currencyCode: asCurrencyCode('EURO') },
        { merchantId: TEST_MERCHANT_ID, idempotencyKey: 'key-3' },
      ),
    ).rejects.toBeInstanceOf(VivaValidationError);

    await agent.close();
  });

  /**
   * Test 3: retrieveTransaction returns full transaction with bigint OrderCode preserved.
   *
   * @see references/viva-docs/md/webhooks-for-payments.txt:248
   * @see references/viva-docs/md/account-api.txt:1584
   */
  it('retrieveTransaction returns full transaction with bigint OrderCode', async () => {
    const agent = new MockAgent();
    agent.disableNetConnect();
    const pool = agent.get(API_HOST);

    pool
      .intercept({
        path: `/checkout/v2/isv/transactions/${TEST_TRANSACTION_ID}?merchantId=${TEST_MERCHANT_ID}`,
        method: 'GET',
      })
      .reply(
        200,
        JSON.stringify({
          transactionId: TEST_TRANSACTION_ID,
          OrderCode: 5555555555,
          statusId: 'F',
          amount: 1234,
          currencyCode: '978',
          merchantId: TEST_MERCHANT_ID,
          parentId: null,
          insDate: '2024-01-15T10:00:00Z',
          transactionTypeId: 5,
          email: 'customer@example.com',
        }),
        { headers: { 'Content-Type': 'application/json' } },
      );

    const payments = buildPayments(agent);
    const tx = await payments.retrieveTransaction(TEST_TRANSACTION_ID, {
      merchantId: TEST_MERCHANT_ID,
    });

    expect(tx.transactionId).toBe(TEST_TRANSACTION_ID);
    expect(tx.orderCode).toBe(5555555555n);
    expect(typeof tx.orderCode).toBe('bigint');
    expect(tx.statusId).toBe('F');
    // No CardTypeId in this fixture → cardType stays undefined.
    expect(tx.cardTypeId).toBeUndefined();
    expect(tx.cardType).toBeUndefined();
    await agent.close();
  });

  /**
   * Test 3b (slice 5): retrieveTransaction normalizes `cardTypeId` → `cardType` string.
   *
   * Per `wh-transaction-payment-created.txt` (CardTypeId table), Viva sends `0`
   * for Visa. The normalized response surfaces `cardType: 'Visa'` so
   * `resolveRefundStrategy` can consume it directly.
   *
   * @see ../../src/types/card-types.ts
   * @see ../../src/refunds/strategy.ts
   */
  it('retrieveTransaction derives cardType string from CardTypeId', async () => {
    const agent = new MockAgent();
    agent.disableNetConnect();
    const pool = agent.get(API_HOST);

    pool
      .intercept({
        path: `/checkout/v2/isv/transactions/${TEST_TRANSACTION_ID}?merchantId=${TEST_MERCHANT_ID}`,
        method: 'GET',
      })
      .reply(
        200,
        JSON.stringify({
          transactionId: TEST_TRANSACTION_ID,
          OrderCode: 5555555556,
          statusId: 'F',
          amount: 1234,
          currencyCode: '978',
          merchantId: TEST_MERCHANT_ID,
          parentId: null,
          insDate: '2024-01-15T10:00:00Z',
          transactionTypeId: 5,
          CardTypeId: 0, // Visa per wh-* doc
        }),
        { headers: { 'Content-Type': 'application/json' } },
      );

    const payments = buildPayments(agent);
    const tx = await payments.retrieveTransaction(TEST_TRANSACTION_ID, {
      merchantId: TEST_MERCHANT_ID,
    });

    expect(tx.cardTypeId).toBe(0);
    expect(tx.cardType).toBe('Visa');
    await agent.close();
  });

  /**
   * Test 4: refundPayment (partial) — calls LEGACY HOST with form-encoded Amount.
   *
   * Probe-verified 2026-04-25 (F1): refund must go to legacy host with Basic auth.
   * - Host: https://demo.vivapayments.com
   * - Path: POST /api/transactions/{transactionId}
   * - Body: application/x-www-form-urlencoded (Amount={minor}&SourceCode=Default)
   * - Auth: Basic base64(merchantId:apiKey)
   * - Response: PascalCase JSON { TransactionId, StatusId, Amount }
   *
   * @see references/viva-docs/md/tut-create-recurring-payment.txt:288
   */
  it('refundPayment (partial) → POSTs to LEGACY HOST with form-encoded Amount', async () => {
    const agent = new MockAgent();
    agent.disableNetConnect();
    const legacyPool = agent.get(LEGACY_HOST);

    let capturedBody: string = '';
    let capturedAuthHeader: string = '';

    legacyPool
      .intercept({
        path: `/api/transactions/${TEST_TRANSACTION_ID}`,
        method: 'POST',
      })
      .reply(
        200,
        (opts) => {
          capturedBody = opts.body as string;
          const headers = opts.headers as Record<string, string> | undefined;
          capturedAuthHeader = headers?.['authorization'] ?? headers?.['Authorization'] ?? '';
          return JSON.stringify({ TransactionId: 'refund-tx-uuid', StatusId: 'F', Amount: 500 });
        },
        { headers: { 'Content-Type': 'application/json' } },
      );

    const payments = buildPaymentsWithLegacy(agent);
    const result = await payments.refundPayment(TEST_TRANSACTION_ID, {
      merchantId: TEST_MERCHANT_ID,
      amountMinor: 500n,
      idempotencyKey: 'refund-key-1',
    });

    expect(result.transactionId).toBe('refund-tx-uuid');
    expect(result.statusId).toBe('F');
    expect(result.amount).toBe(500n);

    // Assert form-encoded body contains Amount and SourceCode
    const params = new URLSearchParams(capturedBody);
    expect(params.get('Amount')).toBe('500');
    expect(params.get('SourceCode')).toBe('Default');

    // Assert Basic auth header is set (Base64 of merchantId:apiKey)
    expect(capturedAuthHeader).toMatch(/^Basic /);

    await agent.close();
  });

  /**
   * Test 4b: refundPayment (full) → no Amount in form body.
   *
   * Per Viva convention, omitting Amount from the form body triggers a full refund.
   *
   * @see references/viva-docs/md/tut-create-recurring-payment.txt:288
   */
  it('refundPayment (full refund) → no Amount in form body, SourceCode=Default', async () => {
    const agent = new MockAgent();
    agent.disableNetConnect();
    const legacyPool = agent.get(LEGACY_HOST);

    let capturedBody: string = '';

    legacyPool
      .intercept({
        path: `/api/transactions/${TEST_TRANSACTION_ID}`,
        method: 'POST',
      })
      .reply(
        200,
        (opts) => {
          capturedBody = opts.body as string;
          return JSON.stringify({ TransactionId: 'refund-tx-full', StatusId: 'F' });
        },
        { headers: { 'Content-Type': 'application/json' } },
      );

    const payments = buildPaymentsWithLegacy(agent);
    const result = await payments.refundPayment(TEST_TRANSACTION_ID, {
      merchantId: TEST_MERCHANT_ID,
      idempotencyKey: 'refund-key-full',
    });

    expect(result.transactionId).toBe('refund-tx-full');

    // Amount must NOT be in the form body for a full refund
    const params = new URLSearchParams(capturedBody);
    expect(params.has('Amount')).toBe(false);
    expect(params.get('SourceCode')).toBe('Default');

    await agent.close();
  });

  /**
   * Test 4c: refundPayment without legacyClient → throws VivaValidationError.
   * If the caller did not configure basic-auth creds, the error is clear and actionable.
   */
  it('refundPayment — no legacyClient configured → throws VivaValidationError', async () => {
    const agent = new MockAgent();
    agent.disableNetConnect();

    // buildPayments() does NOT include a legacyClient
    const payments = buildPayments(agent);

    await expect(
      payments.refundPayment(TEST_TRANSACTION_ID, {
        merchantId: TEST_MERCHANT_ID,
        amountMinor: 100n,
        idempotencyKey: 'key-no-legacy',
      }),
    ).rejects.toBeInstanceOf(VivaValidationError);

    await agent.close();
  });

  /**
   * Test 4d: refundPayment — 404 from legacy host → VivaApiError (not found).
   *
   * @see references/viva-docs/md/tut-create-recurring-payment.txt:288
   */
  it('refundPayment — 404 from legacy host → throws VivaApiError', async () => {
    const agent = new MockAgent();
    agent.disableNetConnect();
    const legacyPool = agent.get(LEGACY_HOST);

    legacyPool
      .intercept({
        path: `/api/transactions/${TEST_TRANSACTION_ID}`,
        method: 'POST',
      })
      .reply(404, '{"message":"not found"}', { headers: { 'Content-Type': 'application/json' } });

    const payments = buildPaymentsWithLegacy(agent);

    const err = await payments.refundPayment(TEST_TRANSACTION_ID, {
      merchantId: TEST_MERCHANT_ID,
      amountMinor: 100n,
      idempotencyKey: 'key-404',
    }).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(VivaApiError);
    expect((err as VivaApiError).httpStatus).toBe(404);

    await agent.close();
  });

  /**
   * Test 4e: refundPayment — 5xx from legacy host → throws VivaApiError (no retry for non-idempotent).
   *
   * @see references/viva-docs/md/tut-create-recurring-payment.txt:288
   */
  it('refundPayment (non-idempotent) does NOT retry on 5xx', async () => {
    const agent = new MockAgent();
    agent.disableNetConnect();
    const legacyPool = agent.get(LEGACY_HOST);

    let attempts = 0;

    legacyPool
      .intercept({
        path: `/api/transactions/${TEST_TRANSACTION_ID}`,
        method: 'POST',
      })
      .reply(
        503,
        () => {
          attempts++;
          return '{"error":"unavailable"}';
        },
        { headers: { 'Content-Type': 'application/json' } },
      );

    const payments = buildPaymentsWithLegacy(agent);

    await expect(
      payments.refundPayment(TEST_TRANSACTION_ID, {
        merchantId: TEST_MERCHANT_ID,
        amountMinor: 100n,
        idempotencyKey: 'key-no-retry',
      }),
    ).rejects.toBeInstanceOf(VivaApiError);

    expect(attempts).toBe(1); // No retry on 5xx for non-idempotent
    await agent.close();
  });

  /**
   * Test 4f: refundPayment — custom SourceCode is sent in form body.
   */
  it('refundPayment — custom sourceCode is included in form body', async () => {
    const agent = new MockAgent();
    agent.disableNetConnect();
    const legacyPool = agent.get(LEGACY_HOST);

    let capturedBody: string = '';

    legacyPool
      .intercept({
        path: `/api/transactions/${TEST_TRANSACTION_ID}`,
        method: 'POST',
      })
      .reply(
        200,
        (opts) => {
          capturedBody = opts.body as string;
          return JSON.stringify({ TransactionId: 'refund-tx-src', StatusId: 'F' });
        },
        { headers: { 'Content-Type': 'application/json' } },
      );

    const payments = buildPaymentsWithLegacy(agent);
    await payments.refundPayment(TEST_TRANSACTION_ID, {
      merchantId: TEST_MERCHANT_ID,
      amountMinor: 200n,
      sourceCode: 'MySource',
      idempotencyKey: 'key-src',
    });

    const params = new URLSearchParams(capturedBody);
    expect(params.get('SourceCode')).toBe('MySource');

    await agent.close();
  });

  /**
   * Test 5: cancelOrder is idempotent — retries on 5xx.
   *
   * cancelOrder is marked idempotent: true, so it retries 5xx up to MAX_RETRIES.
   *
   * @see references/viva-docs/md/payment-isv-api.txt:1
   * @see references/viva-docs/md/webhooks-for-payments.txt:205 (4865 event)
   */
  it('cancelOrder retries on 5xx (idempotent: true)', async () => {
    const agent = new MockAgent();
    agent.disableNetConnect();
    const pool = agent.get(API_HOST);

    let attempts = 0;

    // First attempt: 503
    pool
      .intercept({ path: '/checkout/v2/orders/12345?merchantId=merchant-uuid-1234', method: 'DELETE' })
      .reply(
        503,
        () => {
          attempts++;
          return '{"error":"unavailable"}';
        },
        { headers: { 'Content-Type': 'application/json' } },
      );

    // Second attempt: 200
    pool
      .intercept({ path: '/checkout/v2/orders/12345?merchantId=merchant-uuid-1234', method: 'DELETE' })
      .reply(
        200,
        () => {
          attempts++;
          return JSON.stringify({ OrderCode: 12345, ErrorCode: 0, ErrorText: '' });
        },
        { headers: { 'Content-Type': 'application/json' } },
      );

    const payments = buildPayments(agent);
    const result = await payments.cancelOrder(12345n, { merchantId: TEST_MERCHANT_ID });

    expect(result.orderCode).toBe(12345n);
    expect(result.errorCode).toBe(0);
    expect(attempts).toBe(2); // confirmed it retried
    await agent.close();
  });
});

// ---------------------------------------------------------------------------
// x-viva-correlationid / x-viva-eventid header extraction
//
// Probe-verified 2026-04-25 (F4): both headers are present on every Viva response.
// IsvHttpClient must extract them and attach to VivaApiError / make accessible
// via requestWithMeta().
// ---------------------------------------------------------------------------

describe('IsvHttpClient — Viva tracing header extraction (F4)', () => {
  /**
   * requestWithMeta returns vivaCorrelationId + vivaEventId from response headers.
   */
  it('requestWithMeta: extracts x-viva-correlationid and x-viva-eventid', async () => {
    const agent = new MockAgent();
    agent.disableNetConnect();
    const pool = agent.get(API_HOST);

    pool
      .intercept({ path: '/checkout/v2/orders?merchantId=merchant-uuid-1234', method: 'POST' })
      .reply(
        200,
        JSON.stringify({ OrderCode: 111 }),
        {
          headers: {
            'Content-Type': 'application/json',
            'x-viva-correlationid': '26-115-EDAA55BC',
            'x-viva-eventid': '42',
          },
        },
      );

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

    const { data, vivaCorrelationId, vivaEventId } = await client.requestWithMeta<{ OrderCode: number }>({
      method: 'POST',
      path: '/checkout/v2/orders',
      query: { merchantId: TEST_MERCHANT_ID },
      body: { amount: 100, currencyCode: 978 },
      idempotent: false,
      endpoint: 'POST /checkout/v2/orders',
    });

    // OrderCode is parsed as BigInt by bigintSafeParse (int64 precision)
    expect(data.OrderCode).toBe(111n);
    expect(vivaCorrelationId).toBe('26-115-EDAA55BC');
    expect(vivaEventId).toBe('42');

    await agent.close();
  });

  /**
   * On error responses, vivaCorrelationId is attached to the thrown VivaApiError.
   */
  it('VivaApiError carries vivaCorrelationId from x-viva-correlationid header', async () => {
    const agent = new MockAgent();
    agent.disableNetConnect();
    const pool = agent.get(API_HOST);

    pool
      .intercept({ path: '/checkout/v2/transactions/bad-tx', method: 'GET' })
      .reply(
        404,
        JSON.stringify({ status: 404, message: null, eventId: '0' }),
        {
          headers: {
            'Content-Type': 'application/json',
            'x-viva-correlationid': '99-AABBCC',
            'x-viva-eventid': '0',
          },
        },
      );

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

    const err = await client.request<unknown>({
      method: 'GET',
      path: '/checkout/v2/transactions/bad-tx',
      idempotent: true,
      endpoint: 'GET /checkout/v2/transactions/{transactionId}',
    }).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(VivaApiError);
    expect((err as VivaApiError).vivaCorrelationId).toBe('99-AABBCC');
    expect((err as VivaApiError).vivaEventId).toBe('0');

    await agent.close();
  });
});

// ---------------------------------------------------------------------------
// 401 → reseller fallback (D15) tests
//
// For cancelOrder and retrieveTransaction ONLY:
//   a) happy path: OAuth2 succeeds, secondary not called
//   b) 401 → fallback succeeds
//   c) 401 → fallback also 401 → throws VivaAuthError
//   d) secondary undefined → 401 → throws VivaAuthError (no fallback attempted)
//
// NOTE: refundPayment 401-fallback tests are NOT included here.
// Per probe F1 (2026-04-25), Viva returns 405 on the v2/OAuth2 refund path
// (not 401). The fallback never triggers. refundPayment now calls legacyClient
// directly. Removed test cases:
//   - "refundPayment: primary 401 → reseller fallback succeeds"
//   - "refundPayment: primary 401 → fallback 401 → throws VivaAuthError"
//   - "refundPayment: secondary undefined → 401 → throws VivaAuthError"
//   - "refundPayment: OAuth2 succeeds → secondary not called"
//
// @see references/viva-docs/md/isv-credentials.txt:107 (reseller basic-auth)
// @see docs/plans/vendure-plugin-v0.md §D15 (reseller fallback scope)
// ---------------------------------------------------------------------------

describe('IsvPayments — 401 reseller fallback (D15)', () => {
  // -------------------------------------------------------------------------
  // cancelOrder
  // -------------------------------------------------------------------------

  /**
   * cancelOrder happy path: OAuth2 succeeds, secondary client is never called.
   * We register only one interceptor (the primary). If the secondary were called,
   * MockAgent would throw a connection error on the second request — test would fail.
   */
  it('cancelOrder: OAuth2 succeeds → secondary not called', async () => {
    const agent = new MockAgent();
    agent.disableNetConnect();
    const pool = agent.get(API_HOST);

    let intercepted = false;
    pool
      .intercept({ path: '/checkout/v2/orders/12345?merchantId=merchant-uuid-1234', method: 'DELETE' })
      .reply(
        200,
        () => {
          intercepted = true;
          return JSON.stringify({ OrderCode: 12345, ErrorCode: 0, ErrorText: '' });
        },
        { headers: { 'Content-Type': 'application/json' } },
      );

    const payments = buildPaymentsWithSecondary(agent);
    const result = await payments.cancelOrder(12345n, { merchantId: TEST_MERCHANT_ID });

    expect(result.orderCode).toBe(12345n);
    expect(result.errorCode).toBe(0);
    expect(intercepted).toBe(true);
    await agent.close();
  });

  /**
   * cancelOrder: primary 401 → reseller fallback succeeds.
   * The primary client returns 401 (IsvHttpClient does one internal force-refresh
   * then gives up with VivaAuthError); IsvPayments catches that and retries with
   * the secondary client which succeeds.
   *
   * @see docs/plans/vendure-plugin-v0.md §D15
   */
  it('cancelOrder: primary 401 → reseller fallback succeeds', async () => {
    const agent = new MockAgent();
    agent.disableNetConnect();
    const pool = agent.get(API_HOST);

    // Primary: 401 twice (initial + force-refresh retry inside IsvHttpClient)
    pool
      .intercept({ path: '/checkout/v2/orders/99999?merchantId=merchant-uuid-1234', method: 'DELETE' })
      .reply(401, '{"error":"unauthorized"}', { headers: { 'Content-Type': 'application/json' } });
    pool
      .intercept({ path: '/checkout/v2/orders/99999?merchantId=merchant-uuid-1234', method: 'DELETE' })
      .reply(401, '{"error":"unauthorized"}', { headers: { 'Content-Type': 'application/json' } });

    // Secondary (reseller): succeeds
    pool
      .intercept({ path: '/checkout/v2/orders/99999?merchantId=merchant-uuid-1234', method: 'DELETE' })
      .reply(
        200,
        () => JSON.stringify({ OrderCode: 99999, ErrorCode: 0, ErrorText: '' }),
        { headers: { 'Content-Type': 'application/json' } },
      );

    const payments = buildPaymentsWithSecondary(agent);
    const result = await payments.cancelOrder(99999n, { merchantId: TEST_MERCHANT_ID });

    expect(result.orderCode).toBe(99999n);
    await agent.close();
  });

  /**
   * cancelOrder: primary 401 → reseller fallback also 401 → throws VivaAuthError.
   * No further retry is attempted on the secondary's 401.
   *
   * @see docs/plans/vendure-plugin-v0.md §D15
   */
  it('cancelOrder: primary 401 → fallback 401 → throws VivaAuthError', async () => {
    const agent = new MockAgent();
    agent.disableNetConnect();
    const pool = agent.get(API_HOST);

    // Primary: 401 twice (IsvHttpClient force-refresh cycle)
    pool
      .intercept({ path: '/checkout/v2/orders/77777?merchantId=merchant-uuid-1234', method: 'DELETE' })
      .reply(401, '{"error":"unauthorized"}', { headers: { 'Content-Type': 'application/json' } });
    pool
      .intercept({ path: '/checkout/v2/orders/77777?merchantId=merchant-uuid-1234', method: 'DELETE' })
      .reply(401, '{"error":"unauthorized"}', { headers: { 'Content-Type': 'application/json' } });

    // Secondary: 401 twice (IsvHttpClient force-refresh cycle on secondary)
    pool
      .intercept({ path: '/checkout/v2/orders/77777?merchantId=merchant-uuid-1234', method: 'DELETE' })
      .reply(401, '{"error":"unauthorized"}', { headers: { 'Content-Type': 'application/json' } });
    pool
      .intercept({ path: '/checkout/v2/orders/77777?merchantId=merchant-uuid-1234', method: 'DELETE' })
      .reply(401, '{"error":"unauthorized"}', { headers: { 'Content-Type': 'application/json' } });

    const payments = buildPaymentsWithSecondary(agent);

    await expect(
      payments.cancelOrder(77777n, { merchantId: TEST_MERCHANT_ID }),
    ).rejects.toBeInstanceOf(VivaAuthError);

    await agent.close();
  });

  /**
   * cancelOrder: no secondary configured → primary 401 → throws VivaAuthError (no fallback).
   *
   * @see docs/plans/vendure-plugin-v0.md §D15
   */
  it('cancelOrder: secondary undefined → 401 → throws VivaAuthError (no fallback)', async () => {
    const agent = new MockAgent();
    agent.disableNetConnect();
    const pool = agent.get(API_HOST);

    // Primary: 401 twice (IsvHttpClient force-refresh cycle)
    pool
      .intercept({ path: '/checkout/v2/orders/55555?merchantId=merchant-uuid-1234', method: 'DELETE' })
      .reply(401, '{"error":"unauthorized"}', { headers: { 'Content-Type': 'application/json' } });
    pool
      .intercept({ path: '/checkout/v2/orders/55555?merchantId=merchant-uuid-1234', method: 'DELETE' })
      .reply(401, '{"error":"unauthorized"}', { headers: { 'Content-Type': 'application/json' } });

    // No secondary registered — any extra call would fail via MockAgent
    const payments = buildPayments(agent); // no secondary

    await expect(
      payments.cancelOrder(55555n, { merchantId: TEST_MERCHANT_ID }),
    ).rejects.toBeInstanceOf(VivaAuthError);

    await agent.close();
  });

  // -------------------------------------------------------------------------
  // retrieveTransaction
  // -------------------------------------------------------------------------

  /**
   * retrieveTransaction happy path: OAuth2 succeeds, secondary not called.
   * Only one interceptor registered — a second call would cause MockAgent to throw.
   */
  it('retrieveTransaction: OAuth2 succeeds → secondary not called', async () => {
    const agent = new MockAgent();
    agent.disableNetConnect();
    const pool = agent.get(API_HOST);

    pool
      .intercept({
        path: `/checkout/v2/isv/transactions/${TEST_TRANSACTION_ID}?merchantId=merchant-uuid-1234`,
        method: 'GET',
      })
      .reply(
        200,
        () => JSON.stringify({
          transactionId: TEST_TRANSACTION_ID,
          OrderCode: 1111111111,
          statusId: 'F',
          amount: 500,
          currencyCode: '826',
          merchantId: TEST_MERCHANT_ID,
          parentId: null,
          insDate: '2024-03-01T12:00:00Z',
          transactionTypeId: 5,
        }),
        { headers: { 'Content-Type': 'application/json' } },
      );

    const payments = buildPaymentsWithSecondary(agent);
    const tx = await payments.retrieveTransaction(TEST_TRANSACTION_ID, { merchantId: TEST_MERCHANT_ID });

    expect(tx.transactionId).toBe(TEST_TRANSACTION_ID);
    expect(tx.orderCode).toBe(1111111111n);
    await agent.close();
  });

  /**
   * retrieveTransaction: primary 401 → reseller fallback succeeds.
   *
   * @see docs/plans/vendure-plugin-v0.md §D15
   */
  it('retrieveTransaction: primary 401 → reseller fallback succeeds', async () => {
    const agent = new MockAgent();
    agent.disableNetConnect();
    const pool = agent.get(API_HOST);

    const isvPath = `/checkout/v2/isv/transactions/${TEST_TRANSACTION_ID}?merchantId=merchant-uuid-1234`;

    // Primary: 401 twice
    pool
      .intercept({ path: isvPath, method: 'GET' })
      .reply(401, '{"error":"unauthorized"}', { headers: { 'Content-Type': 'application/json' } });
    pool
      .intercept({ path: isvPath, method: 'GET' })
      .reply(401, '{"error":"unauthorized"}', { headers: { 'Content-Type': 'application/json' } });

    // Secondary: succeeds
    pool
      .intercept({ path: isvPath, method: 'GET' })
      .reply(
        200,
        () => JSON.stringify({
          transactionId: TEST_TRANSACTION_ID,
          OrderCode: 2222222222,
          statusId: 'F',
          amount: 1000,
          currencyCode: '826',
          merchantId: TEST_MERCHANT_ID,
          parentId: null,
          insDate: '2024-03-01T12:00:00Z',
          transactionTypeId: 5,
        }),
        { headers: { 'Content-Type': 'application/json' } },
      );

    const payments = buildPaymentsWithSecondary(agent);
    const tx = await payments.retrieveTransaction(TEST_TRANSACTION_ID, { merchantId: TEST_MERCHANT_ID });

    expect(tx.transactionId).toBe(TEST_TRANSACTION_ID);
    expect(tx.orderCode).toBe(2222222222n);
    await agent.close();
  });

  /**
   * retrieveTransaction: primary 401 → fallback 401 → throws VivaAuthError.
   *
   * @see docs/plans/vendure-plugin-v0.md §D15
   */
  it('retrieveTransaction: primary 401 → fallback 401 → throws VivaAuthError', async () => {
    const agent = new MockAgent();
    agent.disableNetConnect();
    const pool = agent.get(API_HOST);

    const isvPath = `/checkout/v2/isv/transactions/${TEST_TRANSACTION_ID}?merchantId=merchant-uuid-1234`;

    // Primary: 401 twice
    pool
      .intercept({ path: isvPath, method: 'GET' })
      .reply(401, '{"error":"unauthorized"}', { headers: { 'Content-Type': 'application/json' } });
    pool
      .intercept({ path: isvPath, method: 'GET' })
      .reply(401, '{"error":"unauthorized"}', { headers: { 'Content-Type': 'application/json' } });

    // Secondary: 401 twice
    pool
      .intercept({ path: isvPath, method: 'GET' })
      .reply(401, '{"error":"unauthorized"}', { headers: { 'Content-Type': 'application/json' } });
    pool
      .intercept({ path: isvPath, method: 'GET' })
      .reply(401, '{"error":"unauthorized"}', { headers: { 'Content-Type': 'application/json' } });

    const payments = buildPaymentsWithSecondary(agent);

    await expect(
      payments.retrieveTransaction(TEST_TRANSACTION_ID, { merchantId: TEST_MERCHANT_ID }),
    ).rejects.toBeInstanceOf(VivaAuthError);

    await agent.close();
  });

  /**
   * retrieveTransaction: no secondary configured → 401 → throws VivaAuthError (no fallback).
   *
   * @see docs/plans/vendure-plugin-v0.md §D15
   */
  it('retrieveTransaction: secondary undefined → 401 → throws VivaAuthError (no fallback)', async () => {
    const agent = new MockAgent();
    agent.disableNetConnect();
    const pool = agent.get(API_HOST);

    const isvPath = `/checkout/v2/isv/transactions/${TEST_TRANSACTION_ID}?merchantId=merchant-uuid-1234`;

    // Primary: 401 twice
    pool
      .intercept({ path: isvPath, method: 'GET' })
      .reply(401, '{"error":"unauthorized"}', { headers: { 'Content-Type': 'application/json' } });
    pool
      .intercept({ path: isvPath, method: 'GET' })
      .reply(401, '{"error":"unauthorized"}', { headers: { 'Content-Type': 'application/json' } });

    const payments = buildPayments(agent); // no secondary

    await expect(
      payments.retrieveTransaction(TEST_TRANSACTION_ID, { merchantId: TEST_MERCHANT_ID }),
    ).rejects.toBeInstanceOf(VivaAuthError);

    await agent.close();
  });
});
