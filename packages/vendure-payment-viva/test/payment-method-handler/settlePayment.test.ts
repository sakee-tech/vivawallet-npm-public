/**
 * test/payment-method-handler/settlePayment.test.ts
 *
 * Unit tests for vivaPaymentMethodHandler.settlePayment.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Logger } from '@vendure/core';
import { vivaPaymentMethodHandler, _testInjectDeps } from '../../src/payment-method-handler.js';
import { makeOptions, makeCtx, makeOrder, buildOAuth2Strategy, makeMockStateMachine } from './helpers.js';
import { MockAgent } from 'undici';

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
  const options = makeOptions();
  const strategy = buildOAuth2Strategy(agent);
  const stateMachine = makeMockStateMachine();
  _testInjectDeps({ options, oauth2: strategy, stateMachine: stateMachine as any });
  return { stateMachine };
}

describe('settlePayment', () => {
  it('idempotent: already Settled → returns success=true immediately', async () => {
    setupHandler();
    const ctx = makeCtx();
    const order = makeOrder();
    const payment = { id: 99, amount: 1000, state: 'Settled', metadata: {} };

    const result = await (vivaPaymentMethodHandler as any).settlePaymentFn(ctx, order, payment, {});
    expect(result.success).toBe(true);
  });

  it('happy path: updates row status to captured and returns success=true', async () => {
    const { stateMachine } = setupHandler();
    const ctx = makeCtx();
    const order = makeOrder({ id: 5 });
    const payment = { id: 88, amount: 1000, state: 'Created', metadata: {} };

    // Seed a transaction row
    await stateMachine.upsertPendingTransaction(ctx, {
      channelId: 1,
      paymentId: 88,
      idempotencyKey: 'test',
      amountMinor: 1000n,
      currencyCode: 'GBP',
      isvAmountMinor: 0n,
    });

    const result = await (vivaPaymentMethodHandler as any).settlePaymentFn(ctx, order, payment, {});

    expect(result.success).toBe(true);
    expect(result.metadata?.['settledAt']).toBeDefined();

    // Row status should be 'captured'
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
