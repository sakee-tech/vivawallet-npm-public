/**
 * test/merchant-mode/settle-payment.test.ts
 *
 * Slice B — merchant-mode settlePayment behaviour.
 * Mirrors the ISV settlePayment test (state-machine mutation only — no Viva API
 * call from this handler in either mode; the webhook worker is responsible
 * for retrieveTransaction).
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
  const stateMachine = makeMockStateMachine();
  _testInjectDeps({ options, oauth2: strategy, stateMachine: stateMachine as any });
  return { options, stateMachine };
}

describe('merchant-mode settlePayment', () => {
  it('idempotent: already Settled → success=true without DB mutation', async () => {
    const { stateMachine } = setupHandler();
    const ctx = makeCtx();
    const order = makeOrder();
    const payment = { id: 99, amount: 1000, state: 'Settled', metadata: {} };

    const result = await (vivaPaymentMethodHandler as any).settlePaymentFn(ctx, order, payment, {});
    expect(result.success).toBe(true);
    // No row was created and none should exist.
    expect(stateMachine.rows.size).toBe(0);
  });

  it('happy path: updates row status to captured', async () => {
    const { stateMachine } = setupHandler();
    const ctx = makeCtx();
    const order = makeOrder({ id: 5 });
    const payment = { id: 88, amount: 1000, state: 'Created', metadata: {} };

    await stateMachine.upsertPendingTransaction(ctx, {
      channelId: 1,
      paymentId: 88,
      idempotencyKey: 'test',
      amountMinor: 1000n,
      currencyCode: 'EUR',
      isvAmountMinor: 0n,
    });

    const result = await (vivaPaymentMethodHandler as any).settlePaymentFn(ctx, order, payment, {});

    expect(result.success).toBe(true);
    expect(result.metadata?.['settledAt']).toBeDefined();

    const row = stateMachine.rows.get('1:88');
    expect(row?.status).toBe('captured');
  });

  it('no row found → still returns success=true (webhook may set status later)', async () => {
    setupHandler();
    const ctx = makeCtx();
    const order = makeOrder();
    const payment = { id: 777, amount: 500, state: 'Authorized', metadata: {} };

    const result = await (vivaPaymentMethodHandler as any).settlePaymentFn(ctx, order, payment, {});
    expect(result.success).toBe(true);
  });
});
