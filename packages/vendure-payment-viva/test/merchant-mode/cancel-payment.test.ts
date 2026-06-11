/**
 * test/merchant-mode/cancel-payment.test.ts
 *
 * Slice B — merchant-mode cancelPayment behaviour.
 * Verifies: DELETE /checkout/v2/orders/{oc} URL (no merchantId query),
 * row status transition to 'cancelled', terminal-state guard.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { MockAgent } from 'undici';
import { Logger } from '@vendure/core';
import { vivaPaymentMethodHandler, _testInjectDeps } from '../../src/payment-method-handler.js';
import {
  makeMerchantOptions,
  makeCtx,
  makeOrder,
  buildOAuth2Strategy,
  seedToken,
  buildMerchantPayments,
  makeMockStateMachine,
  DEMO_API_HOST,
} from './helpers.js';

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

function setupHandler() {
  const options = makeMerchantOptions();
  const strategy = buildOAuth2Strategy(agent);
  const { isvPayments } = buildMerchantPayments(agent, strategy, options);
  const stateMachine = makeMockStateMachine();
  _testInjectDeps({ options, oauth2: strategy, stateMachine: stateMachine as any, isvPayments });
  return { strategy, stateMachine, isvPayments };
}

async function seedRowWithOrderCode(
  stateMachine: ReturnType<typeof makeMockStateMachine>,
  paymentId: number,
  status: string = 'pending',
) {
  const ctx = makeCtx();
  const { row } = await stateMachine.upsertPendingTransaction(ctx, {
    channelId: 1,
    paymentId,
    idempotencyKey: 'test',
    amountMinor: 1000n,
    currencyCode: 'EUR',
    isvAmountMinor: 0n,
  });
  stateMachine.rows.set(`1:${paymentId}`, {
    ...row as any,
    vivaOrderCode: '9999',
    status: status as any,
    metadata: { vivaMerchantId: 'test-legacy-merchant-uuid', redirectUrl: 'https://demo...' },
  });
  return row;
}

describe('merchant-mode cancelPayment', () => {
  it('DELETEs /checkout/v2/orders/{oc} WITHOUT ?merchantId= and updates row to cancelled', async () => {
    const { strategy, stateMachine } = setupHandler();
    await seedToken(strategy);
    const ctx = makeCtx();
    const order = makeOrder();
    const payment = { id: 10, amount: 1000, state: 'Created', metadata: {} };

    await seedRowWithOrderCode(stateMachine, 10);

    let capturedPath: string | undefined;
    agent
      .get(DEMO_API_HOST)
      .intercept({ path: /\/checkout\/v2\/orders\//, method: 'DELETE' })
      .reply(200, (opts: any) => {
        capturedPath = opts.path as string;
        return { OrderCode: 9999, ErrorCode: 0, ErrorText: 'Success' };
      }, { headers: { 'content-type': 'application/json' } });

    const result = await (vivaPaymentMethodHandler as any).cancelPaymentFn(ctx, order, payment, {});

    expect(result.success).toBe(true);
    expect(capturedPath).toBeDefined();
    expect(capturedPath!).toContain('/checkout/v2/orders/9999');
    expect(capturedPath!).not.toContain('merchantId=');

    const row = stateMachine.rows.get('1:10');
    expect(row?.status).toBe('cancelled');
  });

  it('already-terminal status → VIVA_PAYMENT_NOT_CANCELLABLE', async () => {
    const { stateMachine } = setupHandler();
    const ctx = makeCtx();
    const order = makeOrder();
    const payment = { id: 11, amount: 1000, state: 'Settled', metadata: {} };

    await seedRowWithOrderCode(stateMachine, 11, 'captured');

    const err = await (vivaPaymentMethodHandler as any).cancelPaymentFn(ctx, order, payment, {}).catch((e: any) => e);
    expect(err.code).toBe('VIVA_PAYMENT_NOT_CANCELLABLE');
    expect(err.message).toContain('captured');
  });

  it('missing row → VIVA_PAYMENT_NOT_CANCELLABLE', async () => {
    setupHandler();
    const ctx = makeCtx();
    const order = makeOrder();
    const payment = { id: 9999, amount: 1000, state: 'Created', metadata: {} };

    const err = await (vivaPaymentMethodHandler as any).cancelPaymentFn(ctx, order, payment, {}).catch((e: any) => e);
    expect(err.code).toBe('VIVA_PAYMENT_NOT_CANCELLABLE');
  });
});
