/**
 * test/payment-method-handler/cancelPayment.test.ts
 *
 * Unit tests for vivaPaymentMethodHandler.cancelPayment.
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
// Shared setup
// ---------------------------------------------------------------------------

let agent: MockAgent;

beforeEach(() => {
  agent = new MockAgent();
  agent.disableNetConnect();
  vi.spyOn(Logger, 'info').mockReturnValue(undefined);
  vi.spyOn(Logger, 'warn').mockReturnValue(undefined);
});

afterEach(async () => {
  await agent.close();
  vi.restoreAllMocks();
});

function buildIsvPayments() {
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

function setupHandler() {
  const options = makeOptions();
  const { strategy, isvPayments } = buildIsvPayments();
  const stateMachine = makeMockStateMachine();
  _testInjectDeps({ options, oauth2: strategy, stateMachine: stateMachine as any, isvPayments });
  return { options, strategy, stateMachine, isvPayments };
}

async function seedRowWithOrderCode(stateMachine: ReturnType<typeof makeMockStateMachine>, paymentId: number, status: string = 'pending') {
  const ctx = makeCtx();
  const { row } = await stateMachine.upsertPendingTransaction(ctx, {
    channelId: 1,
    paymentId,
    idempotencyKey: 'test',
    amountMinor: 1000n,
    currencyCode: 'GBP',
    isvAmountMinor: 0n,
  });
  // Simulate that orderCode was set
  stateMachine.rows.set(`1:${paymentId}`, {
    ...row as any,
    vivaOrderCode: '9999',
    status: status as any,
    metadata: { vivaMerchantId: 'merchant-uuid-1234', redirectUrl: 'https://demo...' },
  });
  return row;
}

function mockCancelSuccess(orderCode = '9999') {
  agent.get(DEMO_API_HOST)
    .intercept({ path: new RegExp(`/checkout/v2/orders/${orderCode}`), method: 'DELETE' })
    .reply(200, { OrderCode: orderCode, ErrorCode: 0, ErrorText: 'Success' }, {
      headers: { 'content-type': 'application/json' },
    });
}

function mockCancelError(statusCode: number) {
  // cancelOrder is idempotent → client retries 5xx up to 3 times + 1 auth-refresh = 4 attempts max.
  // Register enough intercepts to cover all retry attempts.
  const pool = agent.get(DEMO_API_HOST);
  for (let i = 0; i < 4; i++) {
    pool
      .intercept({ path: /\/checkout\/v2\/orders\//, method: 'DELETE' })
      .reply(statusCode, { ErrorCode: 100, Message: 'Error' }, {
        headers: { 'content-type': 'application/json' },
      });
  }
}

function mockCancel404() {
  // 404 OrdersOrderCodeNotFound — non-retryable, a single attempt.
  agent.get(DEMO_API_HOST)
    .intercept({ path: /\/checkout\/v2\/orders\//, method: 'DELETE' })
    .reply(404, { ErrorCode: 404, ErrorText: 'OrdersOrderCodeNotFound' }, {
      headers: { 'content-type': 'application/json' },
    });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('cancelPayment', () => {
  it('happy path: voids Viva auth and updates row to cancelled', async () => {
    const { strategy, stateMachine } = setupHandler();
    await seedToken(strategy);
    const ctx = makeCtx();
    const order = makeOrder();
    const payment = { id: 10, amount: 1000, state: 'Created', metadata: {} };

    await seedRowWithOrderCode(stateMachine, 10);
    mockCancelSuccess();

    const result = await (vivaPaymentMethodHandler as any).cancelPaymentFn(ctx, order, payment, {});
    expect(result.success).toBe(true);

    const row = stateMachine.rows.get('1:10');
    expect(row?.status).toBe('cancelled');
  });

  it('missing row → throws VIVA_PAYMENT_NOT_CANCELLABLE', async () => {
    const { strategy } = setupHandler();
    await seedToken(strategy);
    const ctx = makeCtx();
    const order = makeOrder();
    const payment = { id: 999, amount: 500, state: 'Created', metadata: {} };

    const error = await (vivaPaymentMethodHandler as any).cancelPaymentFn(ctx, order, payment, {}).catch((e: any) => e);
    expect(error.code).toBe('VIVA_PAYMENT_NOT_CANCELLABLE');
  });

  it('row exists but no orderCode → throws VIVA_PAYMENT_NOT_CANCELLABLE', async () => {
    const { strategy, stateMachine } = setupHandler();
    await seedToken(strategy);
    const ctx = makeCtx();
    const order = makeOrder({ id: 5 });
    const payment = { id: 50, amount: 500, state: 'Created', metadata: {} };

    // Insert row without orderCode
    await stateMachine.upsertPendingTransaction(ctx, {
      channelId: 1,
      paymentId: 50,
      idempotencyKey: 'test',
      amountMinor: 500n,
      currencyCode: 'GBP',
      isvAmountMinor: 0n,
    });

    const error = await (vivaPaymentMethodHandler as any).cancelPaymentFn(ctx, order, payment, {}).catch((e: any) => e);
    expect(error.code).toBe('VIVA_PAYMENT_NOT_CANCELLABLE');
  });

  it('already-terminal status (captured) → throws VIVA_PAYMENT_NOT_CANCELLABLE', async () => {
    const { strategy, stateMachine } = setupHandler();
    await seedToken(strategy);
    const ctx = makeCtx();
    const order = makeOrder();
    const payment = { id: 20, amount: 1000, state: 'Settled', metadata: {} };

    await seedRowWithOrderCode(stateMachine, 20, 'captured');

    const error = await (vivaPaymentMethodHandler as any).cancelPaymentFn(ctx, order, payment, {}).catch((e: any) => e);
    expect(error.code).toBe('VIVA_PAYMENT_NOT_CANCELLABLE');
    expect(error.message).toContain('captured');
  });

  it('already-cancelled → throws VIVA_PAYMENT_NOT_CANCELLABLE', async () => {
    const { strategy, stateMachine } = setupHandler();
    await seedToken(strategy);
    const ctx = makeCtx();
    const order = makeOrder();
    const payment = { id: 21, amount: 1000, state: 'Cancelled', metadata: {} };

    await seedRowWithOrderCode(stateMachine, 21, 'cancelled');

    const error = await (vivaPaymentMethodHandler as any).cancelPaymentFn(ctx, order, payment, {}).catch((e: any) => e);
    expect(error.code).toBe('VIVA_PAYMENT_NOT_CANCELLABLE');
  });

  it('Viva 4xx → throws VIVA_API_ERROR', async () => {
    const { strategy, stateMachine } = setupHandler();
    await seedToken(strategy);
    const ctx = makeCtx();
    const order = makeOrder();
    const payment = { id: 30, amount: 1000, state: 'Created', metadata: {} };

    await seedRowWithOrderCode(stateMachine, 30);
    mockCancelError(400);

    const error = await (vivaPaymentMethodHandler as any).cancelPaymentFn(ctx, order, payment, {}).catch((e: any) => e);
    expect(error).toBeInstanceOf(VivaPluginError);
    expect(error.code).toBe('VIVA_API_ERROR');
  });

  it('#14: Viva 404 (order already gone) → cancels the local payment and marks the row cancelled', async () => {
    const { strategy, stateMachine } = setupHandler();
    await seedToken(strategy);
    const ctx = makeCtx();
    const order = makeOrder();
    const payment = { id: 32, amount: 1000, state: 'Created', metadata: {} };

    await seedRowWithOrderCode(stateMachine, 32);
    mockCancel404();

    // The Viva order is gone (expired/non-voidable); cancellation must still
    // succeed locally so the order is freed for retry (does NOT throw).
    const result = await (vivaPaymentMethodHandler as any).cancelPaymentFn(ctx, order, payment, {});
    expect(result.success).toBe(true);

    const row = stateMachine.rows.get('1:32');
    expect(row?.status).toBe('cancelled');
    expect(row?.metadata?.['cancelledAt']).toBeTypeOf('string');
  });

  it('Viva 5xx → throws VIVA_AUTH_DOWN (retryable)', async () => {
    const { strategy, stateMachine } = setupHandler();
    await seedToken(strategy);
    const ctx = makeCtx();
    const order = makeOrder();
    const payment = { id: 31, amount: 1000, state: 'Created', metadata: {} };

    await seedRowWithOrderCode(stateMachine, 31);
    mockCancelError(503);

    const error = await (vivaPaymentMethodHandler as any).cancelPaymentFn(ctx, order, payment, {}).catch((e: any) => e);
    expect(error).toBeInstanceOf(VivaPluginError);
    expect(error.code).toBe('VIVA_AUTH_DOWN');
    expect(error.retryable).toBe(true);
  });
});
