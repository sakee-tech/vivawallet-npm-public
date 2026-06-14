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
import { VivaApiError } from '@sakeetech/viva-payments-core/errors';
import type { BasicAuthClient } from '@sakeetech/viva-payments-core/legacy';
import { vivaPaymentMethodHandler, _testInjectDeps } from '../../src/payment-method-handler.js';
import { VivaPluginError } from '../../src/util/error-envelope.js';
import {
  makeOptions,
  makeCtx,
  makeOrder,
  buildOAuth2Strategy,
  seedToken,
  makeMockStateMachine,
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

function setupHandler(resellerLegacyClient?: BasicAuthClient) {
  const options = makeOptions();
  const { strategy, isvPayments } = buildIsvPayments();
  const stateMachine = makeMockStateMachine();
  _testInjectDeps({
    options,
    oauth2: strategy,
    stateMachine: stateMachine as any,
    isvPayments,
    ...(resellerLegacyClient ? { resellerLegacyClient } : {}),
  });
  return { options, strategy, stateMachine, isvPayments };
}

/**
 * Stub reseller legacy client for cancelOrder. In ISV mode the handler cancels
 * via DELETE /api/orders/{oc} on the legacy host with a Reseller-variant
 * BasicAuthClient (the v2/OAuth2 route 404s). Injecting a stub keeps the
 * handler's error-handling logic (success / #14 404-free / #16 4xx-free /
 * 5xx-retryable) under test without a live legacy-host call. The real on-the-wire
 * DELETE /api/orders contract is covered by the live cancel test in
 * viva-payments-core (test/live/card/retrieve-refund-cancel.live.test.ts).
 */
function stubCancelClient(behavior: 'success' | { httpStatus: number }): BasicAuthClient {
  const request = vi.fn(async () => {
    if (behavior !== 'success') {
      throw new VivaApiError({
        message: `cancelOrder failed (HTTP ${behavior.httpStatus})`,
        httpStatus: behavior.httpStatus,
      });
    }
    return {
      data: { OrderCode: 9999, ErrorCode: 0, ErrorText: null, Success: true },
      vivaCorrelationId: undefined,
      vivaEventId: undefined,
    };
  });
  return { request } as unknown as BasicAuthClient;
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

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('cancelPayment', () => {
  it('happy path: voids Viva auth and updates row to cancelled', async () => {
    const { strategy, stateMachine } = setupHandler(stubCancelClient('success'));
    await seedToken(strategy);
    const ctx = makeCtx();
    const order = makeOrder();
    const payment = { id: 10, amount: 1000, state: 'Created', metadata: {} };

    await seedRowWithOrderCode(stateMachine, 10);

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

  it('#33: row missing but payment metadata carries vivaOrderCode → voids Viva via the metadata fallback', async () => {
    const { strategy } = setupHandler(stubCancelClient('success'));
    await seedToken(strategy);
    const ctx = makeCtx();
    const order = makeOrder();
    // No row seeded — the only record of the order code is the Payment metadata
    // persisted by createPayment. A legitimately-initiated payment must stay
    // cancellable so the order can be retried (#33).
    const payment = {
      id: 40,
      amount: 1000,
      state: 'Created',
      metadata: { vivaOrderCode: '9999', vivaMerchantId: 'merchant-uuid-1234' },
    };

    const result = await (vivaPaymentMethodHandler as any).cancelPaymentFn(ctx, order, payment, {});
    expect(result.success).toBe(true);
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

  it('#16: Viva non-404 4xx (non-cancellable state) → frees the local payment so the order can be retried', async () => {
    const { strategy, stateMachine } = setupHandler(stubCancelClient({ httpStatus: 400 }));
    await seedToken(strategy);
    const ctx = makeCtx();
    const order = makeOrder();
    const payment = { id: 30, amount: 1000, state: 'Created', metadata: {} };

    await seedRowWithOrderCode(stateMachine, 30);

    // A non-retryable 4xx means the Viva order cannot be voided through the API,
    // but the local Payment MUST still be freed — otherwise it counts toward
    // totalCoveredByPayments() and bricks every retry with isvAmountTooHigh(_, 0).
    // Must NOT throw (previously threw VIVA_API_ERROR, leaving the order bricked).
    const result = await (vivaPaymentMethodHandler as any).cancelPaymentFn(ctx, order, payment, {});
    expect(result.success).toBe(true);

    const row = stateMachine.rows.get('1:30');
    expect(row?.status).toBe('cancelled');
    expect(row?.metadata?.['cancelledAt']).toBeTypeOf('string');
  });

  it('#14: Viva 404 (order already gone) → cancels the local payment and marks the row cancelled', async () => {
    const { strategy, stateMachine } = setupHandler(stubCancelClient({ httpStatus: 404 }));
    await seedToken(strategy);
    const ctx = makeCtx();
    const order = makeOrder();
    const payment = { id: 32, amount: 1000, state: 'Created', metadata: {} };

    await seedRowWithOrderCode(stateMachine, 32);

    // The Viva order is gone (expired/non-voidable); cancellation must still
    // succeed locally so the order is freed for retry (does NOT throw).
    const result = await (vivaPaymentMethodHandler as any).cancelPaymentFn(ctx, order, payment, {});
    expect(result.success).toBe(true);

    const row = stateMachine.rows.get('1:32');
    expect(row?.status).toBe('cancelled');
    expect(row?.metadata?.['cancelledAt']).toBeTypeOf('string');
  });

  it('Viva 5xx → throws VIVA_AUTH_DOWN (retryable)', async () => {
    const { strategy, stateMachine } = setupHandler(stubCancelClient({ httpStatus: 503 }));
    await seedToken(strategy);
    const ctx = makeCtx();
    const order = makeOrder();
    const payment = { id: 31, amount: 1000, state: 'Created', metadata: {} };

    await seedRowWithOrderCode(stateMachine, 31);

    const error = await (vivaPaymentMethodHandler as any).cancelPaymentFn(ctx, order, payment, {}).catch((e: any) => e);
    expect(error).toBeInstanceOf(VivaPluginError);
    expect(error.code).toBe('VIVA_AUTH_DOWN');
    expect(error.retryable).toBe(true);
  });
});
