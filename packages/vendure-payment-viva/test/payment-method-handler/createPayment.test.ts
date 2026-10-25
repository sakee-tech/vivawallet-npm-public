/**
 * test/payment-method-handler/createPayment.test.ts
 *
 * Unit tests for vivaPaymentMethodHandler.createPayment.
 * HTTP calls mocked via MockAgent (undici). No DB or Vendure boot required.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { MockAgent } from 'undici';
import type { Dispatcher } from 'undici';
import { Logger } from '@vendure/core';
import { IsvHttpClient, IsvPayments } from '@sakeetech/viva-payments-core/isv';
import { vivaPaymentMethodHandler, _testInjectDeps } from '../../src/payment-method-handler.js';
import { VivaPluginError } from '../../src/util/error-envelope.js';
import {
  makeOptions,
  makeCtx,
  makeOrder,
  buildOAuth2Strategy,
  seedToken,
  makeMockStateMachine,
  DEMO_API_HOST,
} from './helpers.js';

// ---------------------------------------------------------------------------
// Test setup helpers
// ---------------------------------------------------------------------------

function buildIsvWithMockAgent(agent: MockAgent) {
  const strategy = buildOAuth2Strategy(agent);
  const client = new IsvHttpClient({
    environment: 'demo',
    authStrategy: strategy,
    dispatcher: agent as unknown as Dispatcher,
    fetchImpl: (url, init) => fetch(url, { ...init, dispatcher: agent as unknown as Dispatcher } as any) as any,
    retryBackoffsMs: [0, 0, 0],
    jitterRatio: 0,
  });
  return { strategy, isvPayments: new IsvPayments(client) };
}

function setupHandler(agent: MockAgent, optionOverrides = {}) {
  const options = makeOptions(optionOverrides);
  const { strategy, isvPayments } = buildIsvWithMockAgent(agent);
  const stateMachine = makeMockStateMachine();
  _testInjectDeps({ options, oauth2: strategy, stateMachine: stateMachine as any, isvPayments });
  return { options, strategy, stateMachine, isvPayments };
}

// Viva order response
function mockVivaOrderResponse(pool: ReturnType<MockAgent['get']>, orderCode = 9876543210n) {
  pool
    .intercept({ path: /\/checkout\/v2\/(isv\/)?orders/, method: 'POST' })
    // Real Viva checkout/v2 shape is lowercase `orderCode` (#9).
    .reply(200, { orderCode: Number(orderCode) }, { headers: { 'content-type': 'application/json' } });
}

function mockVivaOrderError(pool: ReturnType<MockAgent['get']>, statusCode: number, body: object = {}) {
  pool
    .intercept({ path: /\/checkout\/v2\/(isv\/)?orders/, method: 'POST' })
    .reply(statusCode, body, { headers: { 'content-type': 'application/json' } });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

let agent: MockAgent;

beforeEach(async () => {
  agent = new MockAgent();
  agent.disableNetConnect();
  // Silence logger
  vi.spyOn(Logger, 'info').mockReturnValue(undefined);
  vi.spyOn(Logger, 'warn').mockReturnValue(undefined);
});

afterEach(async () => {
  await agent.close();
  vi.restoreAllMocks();
});

describe('createPayment — happy path', () => {
  it('returns Created state + redirectUrl with demo host', async () => {
    const pool = agent.get(DEMO_API_HOST);
    const { strategy } = setupHandler(agent);
    await seedToken(strategy);
    mockVivaOrderResponse(pool, 9876543210n);

    const ctx = makeCtx();
    const order = makeOrder({ currencyCode: 'GBP' });
    const result = await (vivaPaymentMethodHandler as any).createPaymentFn(ctx, order, 2000, {}, {});

    expect(result.state).toBe('Created');
    expect(result.amount).toBe(2000);
    expect(result.metadata['redirectUrl']).toContain('demo.vivapayments.com');
    expect(result.metadata['redirectUrl']).toContain('9876543210');
    expect(result.metadata['vivaOrderCode']).toBe('9876543210');
    expect(result.metadata['vivaMerchantId']).toBe('merchant-uuid-1234');
  });

  it('production env → redirect URL uses www.vivapayments.com', async () => {
    const prodAgent = new MockAgent();
    prodAgent.disableNetConnect();
    const pool = prodAgent.get('https://api.vivapayments.com');
    const options = makeOptions({ environment: 'production' });
    const strategy = buildOAuth2Strategy(prodAgent);
    await seedToken(strategy);
    // Manually construct prod IsvPayments
    const client = new IsvHttpClient({
      environment: 'production',
      authStrategy: strategy,
      dispatcher: prodAgent as unknown as Dispatcher,
      fetchImpl: (url, init) => fetch(url, { ...init, dispatcher: prodAgent as unknown as Dispatcher } as any) as any,
      retryBackoffsMs: [0, 0, 0],
      jitterRatio: 0,
    });
    const isvPayments = new IsvPayments(client);
    const stateMachine = makeMockStateMachine();
    _testInjectDeps({ options, oauth2: strategy, stateMachine: stateMachine as any, isvPayments });

    pool
      .intercept({ path: /\/checkout\/v2\/(isv\/)?orders/, method: 'POST' })
      .reply(200, { orderCode: 111 }, { headers: { 'content-type': 'application/json' } });

    const ctx = makeCtx();
    const order = makeOrder({ currencyCode: 'EUR' });
    const result = await (vivaPaymentMethodHandler as any).createPaymentFn(ctx, order, 1000, {}, {});

    expect(result.metadata['redirectUrl']).toContain('www.vivapayments.com');
    await prodAgent.close();
  });

  it('with color option → redirect URL contains &color=', async () => {
    const pool = agent.get(DEMO_API_HOST);
    const { strategy } = setupHandler(agent, {
      resolveCheckoutColor: () => '#FF5500',
    });
    await seedToken(strategy);
    mockVivaOrderResponse(pool, 111n);

    const ctx = makeCtx();
    const order = makeOrder({ currencyCode: 'GBP' });
    const result = await (vivaPaymentMethodHandler as any).createPaymentFn(ctx, order, 2000, {}, {});

    expect(result.metadata['redirectUrl']).toContain('&color=FF5500');
  });

  it('no color option → no &color= in redirect URL', async () => {
    const pool = agent.get(DEMO_API_HOST);
    const { strategy } = setupHandler(agent);
    await seedToken(strategy);
    mockVivaOrderResponse(pool, 222n);

    const ctx = makeCtx();
    const order = makeOrder({ currencyCode: 'GBP' });
    const result = await (vivaPaymentMethodHandler as any).createPaymentFn(ctx, order, 2000, {}, {});

    expect(result.metadata['redirectUrl']).not.toContain('&color=');
  });

  it('substitutes {orderCode} in successUrl and stores it on row metadata', async () => {
    const pool = agent.get(DEMO_API_HOST);
    const { strategy, stateMachine } = setupHandler(agent, {
      successUrl: 'https://store.com/done?ref={orderCode}',
      failureUrl: 'https://store.com/fail',
    });
    await seedToken(strategy);
    mockVivaOrderResponse(pool, 333n);

    const ctx = makeCtx();
    const order = makeOrder({ id: 10, currencyCode: 'GBP' });
    await (vivaPaymentMethodHandler as any).createPaymentFn(ctx, order, 500, {}, {});

    // Check that the row metadata contains the substituted successUrl
    const row = stateMachine.rows.get('1:10');
    expect(row?.metadata?.['successUrl']).toBe('https://store.com/done?ref=333');
  });
});

describe('createPayment — always mints a fresh order (no reuse)', () => {
  // public #25: a Viva order is a single-use payment intent. Reusing a prior
  // order's redirect (the old time-gated `expiresAt` cache) hands a retry the
  // now-dead checkout (/web2/fail). We mint fresh on every createPayment, like
  // the Vendure Mollie plugin, and treat the row purely as the
  // vivaOrderCode → paymentId correlation record for the settlement webhook.

  it('does NOT stamp expiresAt on the row metadata', async () => {
    const pool = agent.get(DEMO_API_HOST);
    const { strategy, stateMachine } = setupHandler(agent);
    await seedToken(strategy);
    mockVivaOrderResponse(pool, 444n);

    const ctx = makeCtx();
    const order = makeOrder({ id: 15, currencyCode: 'GBP' });
    await (vivaPaymentMethodHandler as any).createPaymentFn(ctx, order, 1000, {}, {});

    const meta = stateMachine.rows.get('1:15')?.metadata as Record<string, unknown>;
    expect(meta['expiresAt']).toBeUndefined();
    expect(meta['redirectUrl']).toContain('ref=444');
  });

  it('second createPayment mints a FRESH order even when a still-live order exists', async () => {
    const pool = agent.get(DEMO_API_HOST);
    const { strategy, stateMachine } = setupHandler(agent);
    await seedToken(strategy);

    // First call — Viva responds with order 555.
    mockVivaOrderResponse(pool, 555n);
    const ctx = makeCtx();
    const order = makeOrder({ id: 20, currencyCode: 'GBP' });
    await (vivaPaymentMethodHandler as any).createPaymentFn(ctx, order, 1000, {}, {});

    // Even with a clearly-future expiry on the row (the old reuse trigger), the
    // second call MUST hit Viva — no reuse, ever.
    const rowKey = '1:20';
    const row = stateMachine.rows.get(rowKey)!;
    stateMachine.rows.set(rowKey, {
      ...row,
      vivaOrderCode: '555',
      metadata: {
        ...row.metadata as object,
        redirectUrl: 'https://demo.vivapayments.com/web/checkout?ref=555',
        expiresAt: Date.now() + 1800 * 1000,
      },
    });

    let callCount = 0;
    pool.intercept({ path: /\/checkout\/v2\/(isv\/)?orders/, method: 'POST' }).reply(200, () => {
      callCount++;
      return { orderCode: 999 };
    }, { headers: { 'content-type': 'application/json' } });

    const result2 = await (vivaPaymentMethodHandler as any).createPaymentFn(ctx, order, 1000, {}, {});
    expect(callCount).toBe(1);
    expect(result2.metadata['vivaOrderCode']).toBe('999');
    expect(result2.metadata['redirectUrl']).toContain('ref=999');
    expect(result2.metadata['redirectUrl']).not.toContain('555');
    // #19: the redirect must still be surfaced in the `public` slice — Vendure's
    // Shop API only exposes `public.*` to customers.
    expect(result2.metadata['public']).toEqual({
      redirectUrl: result2.metadata['redirectUrl'],
    });
  });

  it('overwrites the correlation row with the newest orderCode on each mint', async () => {
    const pool = agent.get(DEMO_API_HOST);
    const { strategy, stateMachine } = setupHandler(agent);
    await seedToken(strategy);

    mockVivaOrderResponse(pool, 555n);
    const ctx = makeCtx();
    const order = makeOrder({ id: 21, currencyCode: 'GBP' });
    await (vivaPaymentMethodHandler as any).createPaymentFn(ctx, order, 1000, {}, {});

    const rowKey = '1:21';
    expect(stateMachine.rows.get(rowKey)?.vivaOrderCode).toBe('555');

    // Retry → fresh order 777 overwrites the row's vivaOrderCode so the inbound
    // settlement webhook (which carries the winning code) resolves correctly.
    pool.intercept({ path: /\/checkout\/v2\/(isv\/)?orders/, method: 'POST' }).reply(200, () => {
      return { orderCode: 777 };
    }, { headers: { 'content-type': 'application/json' } });

    await (vivaPaymentMethodHandler as any).createPaymentFn(ctx, order, 1000, {}, {});
    expect(stateMachine.rows.get(rowKey)?.vivaOrderCode).toBe('777');
  });
});

describe('createPayment — guards', () => {
  it('vivaPayoutsEnabled=false → throws VIVA_ACCOUNT_NOT_VERIFIED', async () => {
    setupHandler(agent);
    const ctx = makeCtx({ vivaPayoutsEnabled: false });
    const order = makeOrder({ currencyCode: 'GBP' });

    await expect((vivaPaymentMethodHandler as any).createPaymentFn(ctx, order, 1000, {}, {})).rejects.toMatchObject({
      code: 'VIVA_ACCOUNT_NOT_VERIFIED',
    });
  });

  it('vivaMerchantId missing → throws VIVA_CHANNEL_MISCONFIGURED', async () => {
    setupHandler(agent);
    const ctx = makeCtx({ vivaMerchantId: null });
    const order = makeOrder({ currencyCode: 'GBP' });

    await expect((vivaPaymentMethodHandler as any).createPaymentFn(ctx, order, 1000, {}, {})).rejects.toMatchObject({
      code: 'VIVA_CHANNEL_MISCONFIGURED',
    });
  });

  it('isvAmount >= amount → throws VIVA_ISV_AMOUNT_TOO_HIGH', async () => {
    setupHandler(agent, { resolveIsvAmount: () => 1000 });
    const ctx = makeCtx();
    const order = makeOrder({ currencyCode: 'GBP' });

    await expect((vivaPaymentMethodHandler as any).createPaymentFn(ctx, order, 1000, {}, {})).rejects.toMatchObject({
      code: 'VIVA_ISV_AMOUNT_TOO_HIGH',
    });
  });

  it('isvAmount === amount → throws VIVA_ISV_AMOUNT_TOO_HIGH (boundary)', async () => {
    setupHandler(agent, { resolveIsvAmount: () => 500 });
    const ctx = makeCtx();
    const order = makeOrder({ currencyCode: 'GBP' });

    await expect((vivaPaymentMethodHandler as any).createPaymentFn(ctx, order, 500, {}, {})).rejects.toMatchObject({
      code: 'VIVA_ISV_AMOUNT_TOO_HIGH',
    });
  });
});

describe('createPayment — Viva errors', () => {
  it('Viva 5xx → throws VIVA_AUTH_DOWN (retryable=true)', async () => {
    const pool = agent.get(DEMO_API_HOST);
    const { strategy } = setupHandler(agent);
    await seedToken(strategy);
    mockVivaOrderError(pool, 503, { ErrorCode: 0, Message: 'Service unavailable' });

    const ctx = makeCtx();
    const order = makeOrder({ currencyCode: 'GBP' });
    const error = await (vivaPaymentMethodHandler as any).createPaymentFn(ctx, order, 1000, {}, {}).catch((e: any) => e);

    expect(error).toBeInstanceOf(VivaPluginError);
    expect(error.code).toBe('VIVA_AUTH_DOWN');
    expect(error.retryable).toBe(true);
  });

  it('Viva 4xx → throws VIVA_API_ERROR with retryable=false and vivaErrorCode pass-through', async () => {
    const pool = agent.get(DEMO_API_HOST);
    const { strategy } = setupHandler(agent);
    await seedToken(strategy);
    mockVivaOrderError(pool, 400, { ErrorCode: 1234, Message: 'Invalid merchant' });

    const ctx = makeCtx();
    const order = makeOrder({ currencyCode: 'GBP' });
    const error = await (vivaPaymentMethodHandler as any).createPaymentFn(ctx, order, 1000, {}, {}).catch((e: any) => e);

    expect(error).toBeInstanceOf(VivaPluginError);
    expect(error.code).toBe('VIVA_API_ERROR');
    expect(error.retryable).toBe(false);
    expect(typeof error.vivaErrorCode).toBe('number');
  });

  it('latency >1200ms → logs warning but does NOT fail the test', async () => {
    const pool = agent.get(DEMO_API_HOST);
    const { strategy } = setupHandler(agent);
    await seedToken(strategy);

    // Delay the response
    pool
      .intercept({ path: /\/checkout\/v2\/(isv\/)?orders/, method: 'POST' })
      .reply(200, { orderCode: 777 }, { headers: { 'content-type': 'application/json' } })
      .delay(1300);

    const ctx = makeCtx();
    const order = makeOrder({ currencyCode: 'GBP', id: 77 });

    // Should succeed despite high latency
    const result = await (vivaPaymentMethodHandler as any).createPaymentFn(ctx, order, 500, {}, {});
    expect(result.state).toBe('Created');
    // Warning should have been logged
    expect(Logger.warn).toHaveBeenCalledWith(
      expect.stringContaining('ms'),
      expect.any(String),
    );
  }, 10_000);
});

// ---------------------------------------------------------------------------
// Regression: ISV platform fee (isvAmount) transmitted in the createOrder body.
// Defect (public #7): the resolved/guarded isvAmount was stored locally but
// omitted from the Viva createOrder call, so no commission was ever taken.
// ---------------------------------------------------------------------------

/**
 * Intercept the createOrder POST and capture the parsed request body for
 * assertions. Returns a getter for the captured body.
 */
function captureOrderBody(pool: ReturnType<MockAgent['get']>, orderCode = 12345): { get: () => any } {
  const captured: { body: any } = { body: undefined };
  pool.intercept({ path: /\/checkout\/v2\/(isv\/)?orders/, method: 'POST' }).reply(
    200,
    (opts: any) => {
      captured.body = JSON.parse(opts.body as string);
      return { orderCode };
    },
    { headers: { 'content-type': 'application/json' } },
  );
  return { get: () => captured.body };
}

describe('createPayment — ISV fee transmission (#7)', () => {
  it('ISV mode with a resolved fee → isvAmount included in the createOrder body', async () => {
    const pool = agent.get(DEMO_API_HOST);
    const { strategy } = setupHandler(agent, { resolveIsvAmount: () => 150 });
    await seedToken(strategy);
    const body = captureOrderBody(pool);

    const ctx = makeCtx();
    const order = makeOrder({ currencyCode: 'GBP' });
    await (vivaPaymentMethodHandler as any).createPaymentFn(ctx, order, 2000, {}, {});

    // Viva semantics: isvAmount is included in (not added to) amount.
    expect(body.get().isvAmount).toBe(150);
    expect(body.get().amount).toBe(2000);
  });

  it('ISV mode with no fee (default 0) → isvAmount omitted (avoids Viva minimum=30)', async () => {
    const pool = agent.get(DEMO_API_HOST);
    const { strategy } = setupHandler(agent); // resolveIsvAmount unset → 0
    await seedToken(strategy);
    const body = captureOrderBody(pool);

    const ctx = makeCtx();
    const order = makeOrder({ currencyCode: 'GBP' });
    await (vivaPaymentMethodHandler as any).createPaymentFn(ctx, order, 2000, {}, {});

    expect(body.get()).not.toHaveProperty('isvAmount');
  });
});

// ---------------------------------------------------------------------------
// Regression: missing orderCode → mappable VIVA_API_ERROR, not a TypeError.
// Defect (public #8): response.orderCode could be undefined and the unguarded
// .toString() surfaced as an opaque 500.
// ---------------------------------------------------------------------------

describe('createPayment — missing orderCode (#8)', () => {
  it('Viva 200 with no OrderCode → throws VIVA_API_ERROR and logs the raw payload', async () => {
    const pool = agent.get(DEMO_API_HOST);
    const { strategy } = setupHandler(agent);
    await seedToken(strategy);
    const errorSpy = vi.spyOn(Logger, 'error').mockReturnValue(undefined);

    // Anomalous response: 200 OK but no OrderCode field.
    pool
      .intercept({ path: /\/checkout\/v2\/(isv\/)?orders/, method: 'POST' })
      .reply(200, {}, { headers: { 'content-type': 'application/json' } });

    const ctx = makeCtx();
    const order = makeOrder({ currencyCode: 'GBP' });
    const error = await (vivaPaymentMethodHandler as any)
      .createPaymentFn(ctx, order, 2000, {}, {})
      .catch((e: any) => e);

    expect(error).toBeInstanceOf(VivaPluginError);
    expect(error.code).toBe('VIVA_API_ERROR');
    expect(error).not.toBeInstanceOf(TypeError);
    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringContaining('no orderCode'),
      expect.any(String),
    );
  });
});
