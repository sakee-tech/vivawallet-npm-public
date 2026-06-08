/**
 * test/payment-method-handler/createRefund.test.ts
 *
 * Unit tests for vivaPaymentMethodHandler.createRefund.
 *
 * F1 (probe 2026-04-25): Refunds go to the legacy host via Basic auth.
 * POST /api/transactions/{transactionId} on demo.vivapayments.com.
 * Interceptors target DEMO_LEGACY_HOST, not DEMO_API_HOST.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { MockAgent } from 'undici';
import type { Dispatcher } from 'undici';
import { Logger } from '@vendure/core';
import { IsvHttpClient, IsvPayments } from '@sakeetech/viva-payments-core/isv';
import { BasicAuthClient as LegacyBasicClient } from '@sakeetech/viva-payments-core/legacy';
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

const DEMO_LEGACY_HOST = 'https://demo.vivapayments.com';

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

/**
 * Build IsvPayments with both an IsvHttpClient (for OAuth2 calls)
 * and a LegacyBasicClient (for refunds) — both backed by the same MockAgent.
 */
function setupHandler() {
  const options = makeOptions();
  const strategy = buildOAuth2Strategy(agent);
  const client = new IsvHttpClient({
    environment: 'demo',
    authStrategy: strategy,
    dispatcher: agent as unknown as Dispatcher,
    fetchImpl: (url, init) => fetch(url, { ...init, dispatcher: agent as unknown as Dispatcher } as any) as any,
    retryBackoffsMs: [0, 0, 0],
    jitterRatio: 0,
  });
  const legacyClient = new LegacyBasicClient({
    environment: 'demo',
    merchantId: options.legacyMerchantId,
    apiKey: options.legacyApiKey,
    dispatcher: agent as unknown as Dispatcher,
    fetchImpl: (url, init) => fetch(url, { ...init, dispatcher: agent as unknown as Dispatcher } as any) as any,
    retryBackoffsMs: [0, 0, 0],
    jitterRatio: 0,
  });
  const isvPayments = new IsvPayments(client, undefined, legacyClient);
  const stateMachine = makeMockStateMachine();
  _testInjectDeps({ options, oauth2: strategy, stateMachine: stateMachine as any, isvPayments });
  return { strategy, stateMachine, isvPayments, legacyClient };
}

async function seedCapturedRow(
  stateMachine: ReturnType<typeof makeMockStateMachine>,
  paymentId: number,
  vivaTransactionId: string | null = 'viva-txn-abc',
) {
  const ctx = makeCtx();
  const { row } = await stateMachine.upsertPendingTransaction(ctx, {
    channelId: 1,
    paymentId,
    idempotencyKey: 'test',
    amountMinor: 2000n,
    currencyCode: 'GBP',
    isvAmountMinor: 0n,
  });
  stateMachine.rows.set(`1:${paymentId}`, {
    ...row as any,
    vivaOrderCode: '9000',
    vivaTransactionId,
    status: 'captured' as any,
    metadata: { vivaMerchantId: 'merchant-uuid-1234' },
  });
}

/**
 * Intercept POST /api/transactions/{transactionId} on the legacy host.
 * Response is PascalCase (Viva legacy API format).
 */
function mockRefundSuccess(transactionId = 'viva-txn-abc') {
  agent.get(DEMO_LEGACY_HOST)
    .intercept({ path: `/api/transactions/${transactionId}`, method: 'POST' })
    .reply(200, { TransactionId: 'refund-txn-xyz', StatusId: 'F', Amount: 2000 }, {
      headers: { 'content-type': 'application/json' },
    });
}

function mockRefundError(statusCode: number) {
  agent.get(DEMO_LEGACY_HOST)
    .intercept({ path: /\/api\/transactions\//, method: 'POST' })
    .reply(statusCode, { ErrorCode: 9999, Message: 'Refund rejected' }, {
      headers: { 'content-type': 'application/json' },
    });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('createRefund', () => {
  it('full refund: amountMinor omitted from Viva call, status → refunded', async () => {
    const { strategy, stateMachine } = setupHandler();
    await seedToken(strategy);
    await seedCapturedRow(stateMachine, 40);
    mockRefundSuccess();

    const ctx = makeCtx();
    const order = makeOrder();
    const payment = { id: 40, amount: 2000, state: 'Settled', metadata: {} };
    const input = { amount: 2000, lines: [] }; // full refund: input.amount === payment.amount

    const result = await (vivaPaymentMethodHandler as any).createRefundFn(ctx, input, 2000, order, payment, {});

    expect(result.state).toBe('Settled');
    expect(result.metadata?.['vivaRefundResponse']?.transactionId).toBe('refund-txn-xyz');

    const row = stateMachine.rows.get('1:40');
    expect(row?.status).toBe('refunded');
  });

  it('partial refund: amountMinor sent, status → partially_refunded', async () => {
    const { strategy, stateMachine } = setupHandler();
    await seedToken(strategy);
    await seedCapturedRow(stateMachine, 41);
    mockRefundSuccess();

    const ctx = makeCtx();
    const order = makeOrder();
    const payment = { id: 41, amount: 2000, state: 'Settled', metadata: {} };
    const input = { amount: 500, lines: [] }; // partial: 500 < 2000

    const result = await (vivaPaymentMethodHandler as any).createRefundFn(ctx, input, 500, order, payment, {});

    expect(result.state).toBe('Settled');
    const row = stateMachine.rows.get('1:41');
    expect(row?.status).toBe('partially_refunded');
    // Accumulated refunded amount stored
    expect((row?.metadata as Record<string, unknown>)?.['refundedAmountMinor']).toBe(500);
  });

  it('status not captured → throws VIVA_REFUND_REJECTED', async () => {
    const { strategy, stateMachine } = setupHandler();
    await seedToken(strategy);
    const ctx = makeCtx();
    await stateMachine.upsertPendingTransaction(ctx, {
      channelId: 1,
      paymentId: 50,
      idempotencyKey: 'test',
      amountMinor: 1000n,
      currencyCode: 'GBP',
      isvAmountMinor: 0n,
    });
    // status stays 'pending'

    const order = makeOrder();
    const payment = { id: 50, amount: 1000, state: 'Created', metadata: {} };
    const input = { amount: 1000, lines: [] };

    const error = await (vivaPaymentMethodHandler as any).createRefundFn(ctx, input, 1000, order, payment, {}).catch((e: any) => e);
    expect(error.code).toBe('VIVA_REFUND_REJECTED');
    expect(error.message).toContain('pending');
  });

  it('no vivaTransactionId yet → throws VIVA_REFUND_REJECTED', async () => {
    const { strategy, stateMachine } = setupHandler();
    await seedToken(strategy);
    await seedCapturedRow(stateMachine, 51, null); // null transactionId

    const ctx = makeCtx();
    const order = makeOrder();
    const payment = { id: 51, amount: 2000, state: 'Settled', metadata: {} };
    const input = { amount: 2000, lines: [] };

    const error = await (vivaPaymentMethodHandler as any).createRefundFn(ctx, input, 2000, order, payment, {}).catch((e: any) => e);
    expect(error.code).toBe('VIVA_REFUND_REJECTED');
    expect(error.message).toContain('webhook');
  });

  it('no row at all → throws VIVA_REFUND_REJECTED', async () => {
    setupHandler();
    const ctx = makeCtx();
    const order = makeOrder();
    const payment = { id: 9999, amount: 500, state: 'Settled', metadata: {} };
    const input = { amount: 500, lines: [] };

    const error = await (vivaPaymentMethodHandler as any).createRefundFn(ctx, input, 500, order, payment, {}).catch((e: any) => e);
    expect(error.code).toBe('VIVA_REFUND_REJECTED');
  });

  it('Viva 4xx on refund → throws VIVA_REFUND_REJECTED', async () => {
    const { strategy, stateMachine } = setupHandler();
    await seedToken(strategy);
    await seedCapturedRow(stateMachine, 60);
    mockRefundError(400);

    const ctx = makeCtx();
    const order = makeOrder();
    const payment = { id: 60, amount: 2000, state: 'Settled', metadata: {} };
    const input = { amount: 2000, lines: [] };

    const error = await (vivaPaymentMethodHandler as any).createRefundFn(ctx, input, 2000, order, payment, {}).catch((e: any) => e);
    expect(error).toBeInstanceOf(VivaPluginError);
    expect(error.code).toBe('VIVA_REFUND_REJECTED');
  });

  it('Viva 5xx on refund → throws VIVA_AUTH_DOWN (retryable)', async () => {
    const { strategy, stateMachine } = setupHandler();
    await seedToken(strategy);
    await seedCapturedRow(stateMachine, 61);
    mockRefundError(503);

    const ctx = makeCtx();
    const order = makeOrder();
    const payment = { id: 61, amount: 2000, state: 'Settled', metadata: {} };
    const input = { amount: 2000, lines: [] };

    const error = await (vivaPaymentMethodHandler as any).createRefundFn(ctx, input, 2000, order, payment, {}).catch((e: any) => e);
    expect(error).toBeInstanceOf(VivaPluginError);
    expect(error.code).toBe('VIVA_AUTH_DOWN');
    expect(error.retryable).toBe(true);
  });
});
