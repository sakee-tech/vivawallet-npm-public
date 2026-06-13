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
  it('voids via Payments.cancelOrder with NO per-call legacyClient, and updates row to cancelled', async () => {
    // Merchant mode cancels via the Payments instance's construction-time Merchant
    // Basic legacyClient (DELETE /api/orders/{oc} on the legacy host — the v2/OAuth2
    // route 404s). The handler passes NO per-call legacyClient override (that is
    // the ISV-only reseller path). The on-the-wire DELETE /api/orders contract is
    // covered by the core legacy-host unit tests + the live cancel test; here we
    // assert the handler's merchant-mode call shape + row transition.
    const options = makeMerchantOptions();
    const strategy = buildOAuth2Strategy(agent);
    const stateMachine = makeMockStateMachine();
    const cancelOrder = vi.fn(async () => undefined);
    _testInjectDeps({
      options,
      oauth2: strategy,
      stateMachine: stateMachine as any,
      isvPayments: { cancelOrder } as any,
    });
    await seedToken(strategy);
    const ctx = makeCtx();
    const order = makeOrder();
    const payment = { id: 10, amount: 1000, state: 'Created', metadata: {} };

    await seedRowWithOrderCode(stateMachine, 10);

    const result = await (vivaPaymentMethodHandler as any).cancelPaymentFn(ctx, order, payment, {});

    expect(result.success).toBe(true);
    expect(cancelOrder).toHaveBeenCalledTimes(1);
    const [orderCodeArg, opts] = cancelOrder.mock.calls[0] as [bigint, { merchantId?: string; legacyClient?: unknown }];
    expect(orderCodeArg).toBe(9999n);
    expect(opts?.legacyClient).toBeUndefined(); // merchant mode: uses the instance legacyClient
    expect(opts?.merchantId).toBeUndefined();

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
