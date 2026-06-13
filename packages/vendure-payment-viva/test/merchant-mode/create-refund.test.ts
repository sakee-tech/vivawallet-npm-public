/**
 * test/merchant-mode/create-refund.test.ts
 *
 * Slice B — merchant-mode createRefund branch coverage:
 *   1. fast strategy with Visa → FastRefundClient.refund hit.
 *   2. auto strategy + Visa + 403 → Fast tried, falls back to Standard.
 *   3. fast strategy + Visa + 403 → no fallback, surfaces VIVA_FAST_REFUND_INELIGIBLE
 *      (the Vendure error envelope wraps the underlying VivaApiError).
 *   4. auto strategy + Amex card → Standard refund (auto-ineligible-scheme).
 *   5. standard strategy → Standard refund regardless of card.
 *   6. no cardType (retrieveTransaction omits it) → auto-no-card-info → Standard.
 *
 * Fast Refund endpoint: POST /acquiring/v1/transactions/{id}:fastrefund (OAuth2).
 * Standard refund endpoint: DELETE /api/transactions/{id}?amount=&sourceCode= (legacy Basic auth).
 * retrieveTransaction (merchant mode): GET /checkout/v2/transactions/{id}.
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
  buildFastRefundClient,
  makeMockStateMachine,
  DEMO_API_HOST,
  DEMO_LEGACY_HOST,
} from './helpers.js';

const VIVA_TXN_ID = 'viva-txn-abc';
const REFUND_AMOUNT = 2000;

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

function setupHandler(overrides: Parameters<typeof makeMerchantOptions>[0] = {}) {
  const options = makeMerchantOptions(overrides);
  const strategy = buildOAuth2Strategy(agent);
  const { isvPayments, httpClient } = buildMerchantPayments(agent, strategy, options);
  const fastRefundClient = buildFastRefundClient(httpClient);
  const stateMachine = makeMockStateMachine();
  _testInjectDeps({
    options,
    oauth2: strategy,
    stateMachine: stateMachine as any,
    isvPayments,
    fastRefundClient,
  });
  return { strategy, stateMachine, isvPayments };
}

async function seedCapturedRow(
  stateMachine: ReturnType<typeof makeMockStateMachine>,
  paymentId: number,
) {
  const ctx = makeCtx();
  const { row } = await stateMachine.upsertPendingTransaction(ctx, {
    channelId: 1,
    paymentId,
    idempotencyKey: 'test',
    amountMinor: BigInt(REFUND_AMOUNT),
    currencyCode: 'EUR',
    isvAmountMinor: 0n,
  });
  stateMachine.rows.set(`1:${paymentId}`, {
    ...row as any,
    vivaOrderCode: '9000',
    vivaTransactionId: VIVA_TXN_ID,
    status: 'captured' as any,
    metadata: { vivaMerchantId: 'test-legacy-merchant-uuid' },
  });
}

// ---------------------------------------------------------------------------
// Intercept helpers
// ---------------------------------------------------------------------------

/**
 * Mock retrieveTransaction (merchant mode: GET /checkout/v2/transactions/{id}).
 * `cardTypeId` drives the refund-strategy decision (Visa=0, MC=1, Amex=3).
 */
function mockRetrieveTransaction(cardTypeId: number | undefined) {
  agent
    .get(DEMO_API_HOST)
    .intercept({ path: new RegExp(`/checkout/v2/transactions/${VIVA_TXN_ID}`), method: 'GET' })
    .reply(
      200,
      {
        TransactionId: VIVA_TXN_ID,
        OrderCode: 9000,
        StatusId: 'F',
        Amount: REFUND_AMOUNT,
        ...(cardTypeId !== undefined ? { CardTypeId: cardTypeId } : {}),
      },
      { headers: { 'content-type': 'application/json' } },
    );
}

function mockFastRefundSuccess(refundTxId = 'fast-refund-xyz') {
  agent
    .get(DEMO_API_HOST)
    .intercept({ path: new RegExp(`/acquiring/v1/transactions/${VIVA_TXN_ID}:fastrefund`), method: 'POST' })
    .reply(200, { transactionId: refundTxId, eventId: 1, amount: REFUND_AMOUNT }, {
      headers: { 'content-type': 'application/json' },
    });
}

function mockFastRefund403() {
  agent
    .get(DEMO_API_HOST)
    .intercept({ path: new RegExp(`/acquiring/v1/transactions/${VIVA_TXN_ID}:fastrefund`), method: 'POST' })
    .reply(403, { ErrorCode: 99, Message: 'Fast refund ineligible' }, {
      headers: { 'content-type': 'application/json' },
    });
}

function mockStandardRefundSuccess(refundTxId = 'standard-refund-xyz') {
  agent
    .get(DEMO_LEGACY_HOST)
    .intercept({ path: new RegExp(`^/api/transactions/${VIVA_TXN_ID}`), method: 'DELETE' })
    .reply(200, { TransactionId: refundTxId, StatusId: 'F', Amount: REFUND_AMOUNT }, {
      headers: { 'content-type': 'application/json' },
    });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('merchant-mode createRefund — refund strategy branches', () => {
  it('strategy=fast + Visa → calls FastRefundClient (no Standard call)', async () => {
    const { strategy, stateMachine } = setupHandler({ refundStrategy: 'fast' });
    await seedToken(strategy);
    await seedCapturedRow(stateMachine, 40);

    mockRetrieveTransaction(0); // Visa
    mockFastRefundSuccess('fast-refund-1');

    const ctx = makeCtx();
    const order = makeOrder();
    const payment = { id: 40, amount: REFUND_AMOUNT, state: 'Settled', metadata: {} };
    const input = { amount: REFUND_AMOUNT, lines: [] };

    const result = await (vivaPaymentMethodHandler as any).createRefundFn(ctx, input, REFUND_AMOUNT, order, payment, {});

    expect(result.state).toBe('Settled');
    expect(result.metadata?.['vivaRefundResponse']?.transactionId).toBe('fast-refund-1');

    const row = stateMachine.rows.get('1:40');
    expect(row?.status).toBe('refunded');
  });

  it('strategy=auto + Visa + Fast 403 → falls back to Standard refund', async () => {
    const { strategy, stateMachine } = setupHandler({ refundStrategy: 'auto' });
    await seedToken(strategy);
    await seedCapturedRow(stateMachine, 41);

    mockRetrieveTransaction(0); // Visa → fast eligible
    mockFastRefund403();
    mockStandardRefundSuccess('standard-fallback-xyz');

    const ctx = makeCtx();
    const order = makeOrder();
    const payment = { id: 41, amount: REFUND_AMOUNT, state: 'Settled', metadata: {} };
    const input = { amount: REFUND_AMOUNT, lines: [] };

    const result = await (vivaPaymentMethodHandler as any).createRefundFn(ctx, input, REFUND_AMOUNT, order, payment, {});

    expect(result.state).toBe('Settled');
    expect(result.metadata?.['vivaRefundResponse']?.transactionId).toBe('standard-fallback-xyz');

    const row = stateMachine.rows.get('1:41');
    expect(row?.status).toBe('refunded');
  });

  it('strategy=fast + Visa + Fast 403 → VIVA_FAST_REFUND_INELIGIBLE with "does not fall back" message', async () => {
    const { strategy, stateMachine } = setupHandler({ refundStrategy: 'fast' });
    await seedToken(strategy);
    await seedCapturedRow(stateMachine, 42);

    mockRetrieveTransaction(0); // Visa
    mockFastRefund403();

    const ctx = makeCtx();
    const order = makeOrder();
    const payment = { id: 42, amount: REFUND_AMOUNT, state: 'Settled', metadata: {} };
    const input = { amount: REFUND_AMOUNT, lines: [] };

    const err = await (vivaPaymentMethodHandler as any).createRefundFn(ctx, input, REFUND_AMOUNT, order, payment, {}).catch((e: any) => e);
    expect(err.code).toBe('VIVA_FAST_REFUND_INELIGIBLE');
    expect(err.message).toContain('Fast Refund ineligible');
    expect(err.message).toContain('does not fall back');
  });

  it('strategy=auto + Amex card → routes to Standard (auto-ineligible-scheme)', async () => {
    const { strategy, stateMachine } = setupHandler({ refundStrategy: 'auto' });
    await seedToken(strategy);
    await seedCapturedRow(stateMachine, 43);

    mockRetrieveTransaction(3); // Amex → not Fast Refund eligible
    mockStandardRefundSuccess('amex-standard-1');

    const ctx = makeCtx();
    const order = makeOrder();
    const payment = { id: 43, amount: REFUND_AMOUNT, state: 'Settled', metadata: {} };
    const input = { amount: REFUND_AMOUNT, lines: [] };

    const result = await (vivaPaymentMethodHandler as any).createRefundFn(ctx, input, REFUND_AMOUNT, order, payment, {});

    expect(result.state).toBe('Settled');
    expect(result.metadata?.['vivaRefundResponse']?.transactionId).toBe('amex-standard-1');
  });

  it('strategy=standard → Standard refund regardless of card scheme (no retrieveTransaction)', async () => {
    const { strategy, stateMachine } = setupHandler({ refundStrategy: 'standard' });
    await seedToken(strategy);
    await seedCapturedRow(stateMachine, 44);

    // We still mock retrieveTransaction defensively even if 'standard' bypasses
    // the strategy decision logic. The handler calls retrieveTransaction
    // unconditionally for cardType — when the resolved strategy is 'standard'
    // we still need to consume the response.
    mockRetrieveTransaction(0); // Visa, but strategy=standard ignores it
    mockStandardRefundSuccess('standard-only-1');

    const ctx = makeCtx();
    const order = makeOrder();
    const payment = { id: 44, amount: REFUND_AMOUNT, state: 'Settled', metadata: {} };
    const input = { amount: REFUND_AMOUNT, lines: [] };

    const result = await (vivaPaymentMethodHandler as any).createRefundFn(ctx, input, REFUND_AMOUNT, order, payment, {});

    expect(result.state).toBe('Settled');
    expect(result.metadata?.['vivaRefundResponse']?.transactionId).toBe('standard-only-1');
  });

  it('strategy=auto + cardTypeId missing → auto-no-card-info → Standard', async () => {
    const { strategy, stateMachine } = setupHandler({ refundStrategy: 'auto' });
    await seedToken(strategy);
    await seedCapturedRow(stateMachine, 45);

    mockRetrieveTransaction(undefined); // no CardTypeId → cardType=undefined
    mockStandardRefundSuccess('no-card-info-1');

    const ctx = makeCtx();
    const order = makeOrder();
    const payment = { id: 45, amount: REFUND_AMOUNT, state: 'Settled', metadata: {} };
    const input = { amount: REFUND_AMOUNT, lines: [] };

    const result = await (vivaPaymentMethodHandler as any).createRefundFn(ctx, input, REFUND_AMOUNT, order, payment, {});

    expect(result.state).toBe('Settled');
    expect(result.metadata?.['vivaRefundResponse']?.transactionId).toBe('no-card-info-1');
  });
});
