/**
 * merchant-mode.test.ts — Slice 2: Payments class in mode='merchant'.
 *
 * Covers the mode-aware URL builder added in M4 (multi-mode v0):
 *
 *   - createOrder         → POST /checkout/v2/orders                 (no merchantId)
 *   - retrieveTransaction → GET /checkout/v2/transactions/{id}       (no merchantId)
 *   - cancelOrder         → DELETE /checkout/v2/orders/{orderCode}   (no merchantId)
 *
 * Plus the inverse: ISV mode without merchantId throws VivaValidationError
 * before any HTTP call, and isvAmount is stripped from the wire body in
 * merchant mode.
 *
 * All HTTP intercepted via undici MockAgent — no live network.
 *
 * @see docs/plans/multi-mode-v0.md §4 (M4) / §8.1
 * @see docs/ENDPOINTS.md §2.1 (merchant createOrder)
 * @see docs/AUTH.md §3.1
 */

import { describe, it, expect } from 'vitest';
import { MockAgent, fetch as undiciFetch } from 'undici';
import { IsvHttpClient } from '../../src/isv/client.js';
import { Payments } from '../../src/payments/client.js';
import { VivaValidationError } from '../../src/errors/validation-error.js';
import type { AuthStrategy } from '../../src/types/auth.js';
import type { MerchantId, TransactionId, MinorUnits, OrderCode } from '../../src/types/common.js';
import { CURRENCY_CODES } from '../../src/types/common.js';

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

const API_HOST = 'https://demo-api.vivapayments.com';
const TEST_MERCHANT_ID = 'merchant-uuid-1234' as MerchantId;
const TEST_TRANSACTION_ID = 'tx-uuid-5678' as TransactionId;
const TEST_ORDER_CODE = 12345n as unknown as OrderCode;

function makeMockAuthStrategy(): AuthStrategy {
  return {
    name: 'mock',
    async getBearerToken(): Promise<string> {
      return 'test-bearer-token';
    },
  };
}

function buildPayments(agent: MockAgent, mode: 'merchant' | 'isv'): Payments {
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

  return new Payments({ mode, client });
}

// ---------------------------------------------------------------------------
// createOrder — merchant mode
// ---------------------------------------------------------------------------

describe('Payments (mode=merchant) — createOrder', () => {
  /**
   * Test 1: URL is `/checkout/v2/orders` (no `/isv/` segment); no merchantId
   * query parameter; isvAmount stripped from wire body even if caller set it.
   */
  it('uses /checkout/v2/orders, no merchantId query, strips isvAmount from body', async () => {
    const agent = new MockAgent();
    agent.disableNetConnect();
    const pool = agent.get(API_HOST);

    let capturedBody: Record<string, unknown> = {};

    pool
      .intercept({ path: '/checkout/v2/orders', method: 'POST' })
      .reply(
        200,
        (opts) => {
          capturedBody = JSON.parse(opts.body as string) as Record<string, unknown>;
          return JSON.stringify({ OrderCode: 111 });
        },
        { headers: { 'Content-Type': 'application/json' } },
      );

    const payments = buildPayments(agent, 'merchant');
    const result = await payments.createOrder(
      {
        amount: 1234n as MinorUnits,
        currencyCode: CURRENCY_CODES.EUR,
        merchantTrns: 'order-ref-1',
        isvAmount: 50n as MinorUnits, // should be stripped in merchant mode
        preselectedPaymentMethod: 'card', // phantom field — must NOT be transmitted (no such Viva field)
      },
      { idempotencyKey: 'key-merchant-1' },
    );

    expect(result.orderCode).toBe(111n);
    expect(capturedBody).toMatchObject({ amount: 1234, merchantTrns: 'order-ref-1' });
    expect(capturedBody).not.toHaveProperty('isvAmount');
    expect(capturedBody).not.toHaveProperty('preselectedPaymentMethod');
    await agent.close();
  });

  it('nests customer identity under a `customer` object (not top-level)', async () => {
    const agent = new MockAgent();
    agent.disableNetConnect();
    const pool = agent.get(API_HOST);

    let capturedBody: Record<string, unknown> = {};
    pool
      .intercept({ path: '/checkout/v2/orders', method: 'POST' })
      .reply(
        200,
        (opts) => {
          capturedBody = JSON.parse(opts.body as string) as Record<string, unknown>;
          return JSON.stringify({ orderCode: 222 });
        },
        { headers: { 'Content-Type': 'application/json' } },
      );

    const payments = buildPayments(agent, 'merchant');
    await payments.createOrder(
      {
        amount: 1000n as MinorUnits,
        currencyCode: CURRENCY_CODES.EUR,
        customerEmail: 'buyer@example.com',
        customerFullName: 'George Seferis',
        customerPhone: '+302101234567',
      },
      { idempotencyKey: 'key-customer-nesting' },
    );

    // Viva drops these silently if sent top-level — they MUST be nested.
    expect(capturedBody).not.toHaveProperty('email');
    expect(capturedBody).not.toHaveProperty('fullName');
    expect(capturedBody).not.toHaveProperty('phone');
    expect(capturedBody['customer']).toEqual({
      email: 'buyer@example.com',
      fullName: 'George Seferis',
      phone: '+302101234567',
    });
    await agent.close();
  });

  /**
   * Test 2: merchant mode succeeds without merchantId in opts.
   */
  it('succeeds without merchantId in opts', async () => {
    const agent = new MockAgent();
    agent.disableNetConnect();
    const pool = agent.get(API_HOST);

    pool
      .intercept({ path: '/checkout/v2/orders', method: 'POST' })
      .reply(200, '{"OrderCode":222}', { headers: { 'Content-Type': 'application/json' } });

    const payments = buildPayments(agent, 'merchant');
    const result = await payments.createOrder(
      { amount: 500n as MinorUnits, currencyCode: CURRENCY_CODES.EUR },
      { idempotencyKey: 'key-merchant-2' },
    );

    expect(result.orderCode).toBe(222n);
    await agent.close();
  });

  /**
   * Test 3: merchant mode silently ignores merchantId in opts — no `merchantId`
   * query string segment. The mock matches the bare URL.
   */
  it('silently ignores merchantId in opts (no query string added)', async () => {
    const agent = new MockAgent();
    agent.disableNetConnect();
    const pool = agent.get(API_HOST);

    pool
      // exact-match path with no query string. A request that adds
      // ?merchantId=... would fail to match this interceptor.
      .intercept({ path: '/checkout/v2/orders', method: 'POST' })
      .reply(200, '{"OrderCode":333}', { headers: { 'Content-Type': 'application/json' } });

    const payments = buildPayments(agent, 'merchant');
    const result = await payments.createOrder(
      { amount: 500n as MinorUnits, currencyCode: CURRENCY_CODES.EUR },
      {
        merchantId: TEST_MERCHANT_ID, // ignored in merchant mode
        idempotencyKey: 'key-merchant-3',
      },
    );

    expect(result.orderCode).toBe(333n);
    await agent.close();
  });
});

// ---------------------------------------------------------------------------
// retrieveTransaction — merchant mode
// ---------------------------------------------------------------------------

describe('Payments (mode=merchant) — retrieveTransaction', () => {
  /**
   * Test 4: URL is `/checkout/v2/transactions/{id}`; no merchantId query.
   */
  it('uses /checkout/v2/transactions/{id}, no merchantId query', async () => {
    const agent = new MockAgent();
    agent.disableNetConnect();
    const pool = agent.get(API_HOST);

    pool
      .intercept({ path: `/checkout/v2/transactions/${TEST_TRANSACTION_ID}`, method: 'GET' })
      .reply(
        200,
        JSON.stringify({
          transactionId: TEST_TRANSACTION_ID,
          OrderCode: 9999,
          statusId: 'F',
          amount: 100,
          currencyCode: '978',
          merchantId: TEST_MERCHANT_ID,
          parentId: null,
          insDate: '2026-05-12T10:00:00Z',
          transactionTypeId: 5,
        }),
        { headers: { 'Content-Type': 'application/json' } },
      );

    const payments = buildPayments(agent, 'merchant');
    const tx = await payments.retrieveTransaction(TEST_TRANSACTION_ID);

    expect(tx.transactionId).toBe(TEST_TRANSACTION_ID);
    expect(tx.orderCode).toBe(9999n);
    await agent.close();
  });

  it('falls back to the input transactionId when the v2 response omits it (spec: no transactionId field)', async () => {
    const agent = new MockAgent();
    agent.disableNetConnect();
    const pool = agent.get(API_HOST);

    // Real v2 GET response shape per payment-isv-api.yaml:6258 — NO transactionId.
    pool
      .intercept({ path: `/checkout/v2/transactions/${TEST_TRANSACTION_ID}`, method: 'GET' })
      .reply(
        200,
        JSON.stringify({
          orderCode: 9999,
          statusId: 'F',
          amount: 100,
          currencyCode: '978',
          insDate: '2026-05-12T10:00:00Z',
          transactionTypeId: 5,
        }),
        { headers: { 'Content-Type': 'application/json' } },
      );

    const payments = buildPayments(agent, 'merchant');
    const tx = await payments.retrieveTransaction(TEST_TRANSACTION_ID);

    // Must echo the id the caller passed, not undefined.
    expect(tx.transactionId).toBe(TEST_TRANSACTION_ID);
    await agent.close();
  });

  /**
   * Test 5: merchantId passed in opts is silently ignored in merchant mode.
   */
  it('silently ignores merchantId in opts', async () => {
    const agent = new MockAgent();
    agent.disableNetConnect();
    const pool = agent.get(API_HOST);

    pool
      .intercept({ path: `/checkout/v2/transactions/${TEST_TRANSACTION_ID}`, method: 'GET' })
      .reply(
        200,
        JSON.stringify({
          transactionId: TEST_TRANSACTION_ID,
          OrderCode: 8888,
          statusId: 'F',
          amount: 100,
          currencyCode: '978',
          merchantId: TEST_MERCHANT_ID,
          parentId: null,
          insDate: '2026-05-12T10:00:00Z',
          transactionTypeId: 5,
        }),
        { headers: { 'Content-Type': 'application/json' } },
      );

    const payments = buildPayments(agent, 'merchant');
    const tx = await payments.retrieveTransaction(TEST_TRANSACTION_ID, {
      merchantId: TEST_MERCHANT_ID, // ignored
    });

    expect(tx.orderCode).toBe(8888n);
    await agent.close();
  });
});

// ---------------------------------------------------------------------------
// cancelOrder — merchant mode
// ---------------------------------------------------------------------------

describe('Payments (mode=merchant) — cancelOrder', () => {
  /**
   * Test 6: URL is `/checkout/v2/orders/{orderCode}`; no merchantId query.
   */
  it('uses /checkout/v2/orders/{orderCode}, no merchantId query', async () => {
    const agent = new MockAgent();
    agent.disableNetConnect();
    const pool = agent.get(API_HOST);

    pool
      .intercept({ path: `/checkout/v2/orders/${TEST_ORDER_CODE}`, method: 'DELETE' })
      .reply(
        200,
        JSON.stringify({ OrderCode: TEST_ORDER_CODE.toString(), ErrorCode: 0, ErrorText: '' }),
        { headers: { 'Content-Type': 'application/json' } },
      );

    const payments = buildPayments(agent, 'merchant');
    const result = await payments.cancelOrder(TEST_ORDER_CODE);

    expect(result.errorCode).toBe(0);
    await agent.close();
  });
});

// ---------------------------------------------------------------------------
// ISV mode — merchantId required
// ---------------------------------------------------------------------------

describe('Payments (mode=isv) — merchantId required', () => {
  /**
   * Test 7: createOrder in ISV mode without merchantId throws VivaValidationError
   * before any HTTP call.
   */
  it('createOrder without merchantId throws VivaValidationError (no HTTP call)', async () => {
    const agent = new MockAgent();
    agent.disableNetConnect();
    // No interceptors registered — any HTTP call would throw

    const payments = buildPayments(agent, 'isv');

    await expect(
      payments.createOrder(
        { amount: 1000n as MinorUnits, currencyCode: CURRENCY_CODES.EUR },
        { idempotencyKey: 'isv-key-1' }, // no merchantId
      ),
    ).rejects.toSatisfy((err: unknown) => {
      expect(err).toBeInstanceOf(VivaValidationError);
      expect((err as Error).message).toMatch(/merchantId is required/);
      return true;
    });

    await agent.close();
  });

  /**
   * Test 8: retrieveTransaction in ISV mode without merchantId throws.
   */
  it('retrieveTransaction without merchantId throws VivaValidationError (no HTTP call)', async () => {
    const agent = new MockAgent();
    agent.disableNetConnect();

    const payments = buildPayments(agent, 'isv');

    await expect(
      payments.retrieveTransaction(TEST_TRANSACTION_ID),
    ).rejects.toBeInstanceOf(VivaValidationError);

    await agent.close();
  });

  /**
   * Test 9: cancelOrder in ISV mode without merchantId throws.
   */
  it('cancelOrder without merchantId throws VivaValidationError (no HTTP call)', async () => {
    const agent = new MockAgent();
    agent.disableNetConnect();

    const payments = buildPayments(agent, 'isv');

    await expect(
      payments.cancelOrder(TEST_ORDER_CODE),
    ).rejects.toBeInstanceOf(VivaValidationError);

    await agent.close();
  });
});

// ---------------------------------------------------------------------------
// ISV mode — isvAmount forwarded
// ---------------------------------------------------------------------------

describe('Payments (mode=isv) — isvAmount on the wire', () => {
  /**
   * Test 10: isvAmount IS forwarded in ISV mode (counterpart to test 1).
   */
  it('createOrder forwards isvAmount on the wire body in ISV mode', async () => {
    const agent = new MockAgent();
    agent.disableNetConnect();
    const pool = agent.get(API_HOST);

    let capturedBody: Record<string, unknown> = {};

    pool
      .intercept({ path: `/checkout/v2/isv/orders?merchantId=${TEST_MERCHANT_ID}`, method: 'POST' })
      .reply(
        200,
        (opts) => {
          capturedBody = JSON.parse(opts.body as string) as Record<string, unknown>;
          return JSON.stringify({ OrderCode: 444 });
        },
        { headers: { 'Content-Type': 'application/json' } },
      );

    const payments = buildPayments(agent, 'isv');
    await payments.createOrder(
      {
        amount: 2000n as MinorUnits,
        currencyCode: CURRENCY_CODES.EUR,
        isvAmount: 75n as MinorUnits,
      },
      { merchantId: TEST_MERCHANT_ID, idempotencyKey: 'isv-key-amt' },
    );

    expect(capturedBody).toMatchObject({ amount: 2000, isvAmount: 75 });
    await agent.close();
  });
});

// ---------------------------------------------------------------------------
// URL builder snapshot — exact strings per mode
// ---------------------------------------------------------------------------

describe('Payments URL contract — snapshot per mode', () => {
  /**
   * Test 11: snapshot of exact URL strings for both modes. Locks the contract
   * documented in docs/ENDPOINTS.md.
   */
  it('exact URL strings per mode (merchant vs isv)', async () => {
    const agent = new MockAgent();
    agent.disableNetConnect();
    const pool = agent.get(API_HOST);

    // merchant mode: createOrder, retrieveTransaction, cancelOrder
    pool
      .intercept({ path: '/checkout/v2/orders', method: 'POST' })
      .reply(200, '{"OrderCode":1}', { headers: { 'Content-Type': 'application/json' } });
    pool
      .intercept({ path: `/checkout/v2/transactions/${TEST_TRANSACTION_ID}`, method: 'GET' })
      .reply(
        200,
        JSON.stringify({
          transactionId: TEST_TRANSACTION_ID,
          OrderCode: 1,
          statusId: 'F',
          amount: 1,
          currencyCode: '978',
          merchantId: TEST_MERCHANT_ID,
          parentId: null,
          insDate: '2026-05-12T10:00:00Z',
          transactionTypeId: 5,
        }),
        { headers: { 'Content-Type': 'application/json' } },
      );
    pool
      .intercept({ path: `/checkout/v2/orders/${TEST_ORDER_CODE}`, method: 'DELETE' })
      .reply(
        200,
        JSON.stringify({ OrderCode: TEST_ORDER_CODE.toString(), ErrorCode: 0, ErrorText: '' }),
        { headers: { 'Content-Type': 'application/json' } },
      );

    const merchant = buildPayments(agent, 'merchant');
    await merchant.createOrder(
      { amount: 100n as MinorUnits, currencyCode: CURRENCY_CODES.EUR },
      { idempotencyKey: 'snap-1' },
    );
    await merchant.retrieveTransaction(TEST_TRANSACTION_ID);
    await merchant.cancelOrder(TEST_ORDER_CODE);

    // isv mode: createOrder, retrieveTransaction, cancelOrder
    pool
      .intercept({ path: `/checkout/v2/isv/orders?merchantId=${TEST_MERCHANT_ID}`, method: 'POST' })
      .reply(200, '{"OrderCode":2}', { headers: { 'Content-Type': 'application/json' } });
    pool
      .intercept({
        path: `/checkout/v2/isv/transactions/${TEST_TRANSACTION_ID}?merchantId=${TEST_MERCHANT_ID}`,
        method: 'GET',
      })
      .reply(
        200,
        JSON.stringify({
          transactionId: TEST_TRANSACTION_ID,
          OrderCode: 2,
          statusId: 'F',
          amount: 1,
          currencyCode: '978',
          merchantId: TEST_MERCHANT_ID,
          parentId: null,
          insDate: '2026-05-12T10:00:00Z',
          transactionTypeId: 5,
        }),
        { headers: { 'Content-Type': 'application/json' } },
      );
    pool
      .intercept({
        path: `/checkout/v2/orders/${TEST_ORDER_CODE}?merchantId=${TEST_MERCHANT_ID}`,
        method: 'DELETE',
      })
      .reply(
        200,
        JSON.stringify({ OrderCode: TEST_ORDER_CODE.toString(), ErrorCode: 0, ErrorText: '' }),
        { headers: { 'Content-Type': 'application/json' } },
      );

    const isv = buildPayments(agent, 'isv');
    await isv.createOrder(
      { amount: 100n as MinorUnits, currencyCode: CURRENCY_CODES.EUR },
      { merchantId: TEST_MERCHANT_ID, idempotencyKey: 'snap-2' },
    );
    await isv.retrieveTransaction(TEST_TRANSACTION_ID, { merchantId: TEST_MERCHANT_ID });
    await isv.cancelOrder(TEST_ORDER_CODE, { merchantId: TEST_MERCHANT_ID });

    // If we got here without MockAgent throwing UND_MOCK_ERR_MOCK_NOT_MATCHED,
    // all six URLs matched their interceptors — contract holds.
    expect(true).toBe(true);
    await agent.close();
  });
});
