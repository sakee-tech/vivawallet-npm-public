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
import { readFileSync } from 'node:fs';
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
  // ISV refund builds a reseller-variant client per-call; inject a MockAgent-backed
  // one so the DELETE hits the mock rather than the real Viva host.
  const resellerLegacyClient = new LegacyBasicClient({
    authVariant: 'reseller',
    environment: 'demo',
    resellerId: options.reseller!.resellerId,
    merchantId: 'merchant-uuid-1234',
    resellerApiKey: options.reseller!.resellerApiKey,
    dispatcher: agent as unknown as Dispatcher,
    fetchImpl: (url, init) => fetch(url, { ...init, dispatcher: agent as unknown as Dispatcher } as any) as any,
    retryBackoffsMs: [0, 0, 0],
    jitterRatio: 0,
  });
  const isvPayments = new IsvPayments(client, undefined, legacyClient);
  const stateMachine = makeMockStateMachine();
  _testInjectDeps({ options, oauth2: strategy, stateMachine: stateMachine as any, isvPayments, resellerLegacyClient });
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
 * Intercept DELETE /api/transactions/{transactionId}?amount=&sourceCode= on the
 * legacy host (Viva Cancel transaction). Response is PascalCase.
 */
function mockRefundSuccess(transactionId = 'viva-txn-abc') {
  agent.get(DEMO_LEGACY_HOST)
    .intercept({ path: new RegExp(`^/api/transactions/${transactionId}`), method: 'DELETE' })
    .reply(200, { TransactionId: 'refund-txn-xyz', StatusId: 'F', Amount: 2000 }, {
      headers: { 'content-type': 'application/json' },
    });
}

/** Like mockRefundSuccess, but records each DELETE's query string. */
function captureRefundQueries(times = 1, transactionId = 'viva-txn-abc'): URLSearchParams[] {
  const sent: URLSearchParams[] = [];
  agent.get(DEMO_LEGACY_HOST)
    .intercept({ path: new RegExp(`^/api/transactions/${transactionId}`), method: 'DELETE' })
    .reply(200, (opts) => {
      sent.push(new URL(`http://x${opts.path}`).searchParams);
      return JSON.stringify({ TransactionId: 'refund-txn-xyz', StatusId: 'F', Amount: 20 });
    }, { headers: { 'content-type': 'application/json' } })
    .times(times);
  return sent;
}

function mockRefundError(statusCode: number) {
  agent.get(DEMO_LEGACY_HOST)
    .intercept({ path: /\/api\/transactions\//, method: 'DELETE' })
    .reply(statusCode, { ErrorCode: 9999, Message: 'Refund rejected' }, {
      headers: { 'content-type': 'application/json' },
    });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('createRefund', () => {
  it('full refund: full amount sent explicitly (spec: amount required), status → refunded', async () => {
    const { strategy, stateMachine } = setupHandler();
    await seedToken(strategy);
    await seedCapturedRow(stateMachine, 40);
    const sent = captureRefundQueries();

    const ctx = makeCtx();
    const order = makeOrder();
    const payment = { id: 40, amount: 2000, state: 'Settled', metadata: {} };
    const input = { amount: 2000, lines: [] }; // full refund: input.amount === payment.amount

    const result = await (vivaPaymentMethodHandler as any).createRefundFn(ctx, input, 2000, order, payment, {});

    expect(result.state).toBe('Settled');
    expect(result.metadata?.['vivaRefundResponse']?.transactionId).toBe('refund-txn-xyz');

    const row = stateMachine.rows.get('1:40');
    expect(row?.status).toBe('refunded');
    expect(sent).toHaveLength(1);
    expect(sent[0]!.get('amount')).toBe('2000');
  });

  // #2 — refund idempotency key = payment id + settled refunds before + amount.
  it('#2 key: identical inputs → identical idempotencyKey (a post-rollback retry dedupes at Viva)', async () => {
    const { strategy, stateMachine } = setupHandler();
    await seedToken(strategy);
    await seedCapturedRow(stateMachine, 42);
    const sent = captureRefundQueries(2);
    const payment = { id: 42, amount: 2000, state: 'Settled', metadata: {} };
    const input = { amount: 700, lines: [] };

    await (vivaPaymentMethodHandler as any).createRefundFn(makeCtx(), input, 700, makeOrder(), payment, {});
    // Simulate the caller's transaction rolling back: the row reverts to captured,
    // no Vendure Refund was persisted (settled total unchanged).
    stateMachine.rows.set('1:42', { ...stateMachine.rows.get('1:42')!, status: 'captured' as any });
    await (vivaPaymentMethodHandler as any).createRefundFn(makeCtx(), input, 700, makeOrder(), payment, {});

    expect(sent).toHaveLength(2);
    expect(sent[0]!.get('idempotencyKey')).toBe('viva:refund:42:0:700');
    expect(sent[1]!.get('idempotencyKey')).toBe(sent[0]!.get('idempotencyKey'));
  });

  it('#2 key: a prior settled refund changes the key (legit equal second partial is not deduped)', async () => {
    const { strategy, stateMachine } = setupHandler();
    await seedToken(strategy);
    await seedCapturedRow(stateMachine, 43);
    stateMachine.settledRefundTotals.set('43', 700);
    const sent = captureRefundQueries();
    const payment = { id: 43, amount: 2000, state: 'Settled', metadata: {} };

    await (vivaPaymentMethodHandler as any).createRefundFn(makeCtx(), { amount: 700, lines: [] }, 700, makeOrder(), payment, {});

    expect(sent[0]!.get('idempotencyKey')).toBe('viva:refund:43:700:700');
    expect(sent[0]!.get('amount')).toBe('700');
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

});

// ---------------------------------------------------------------------------
// #4 — VIVA_REFUND_UNCONFIRMED: money MAY have moved but we can't confirm it.
// ---------------------------------------------------------------------------

/** Real probe capture of GET /api/transactions?ordercode= with MerchantTrns tags (Viva demo). */
const LISTING_FIXTURE = JSON.parse(
  readFileSync(
    new URL('../../../viva-payments-core/test/payments/fixtures/transactions-ordercode-3445737288589019-tagged.json', import.meta.url),
    'utf8',
  ),
);
/** Real probe capture: HTTP 200 failure body for a refund over the cumulative cap. */
const REFUND_200_FAILURE = JSON.parse(
  readFileSync(
    new URL('../../../viva-payments-core/test/sandbox/fixtures/isv/refund-200-total-amount-exceeded.json', import.meta.url),
    'utf8',
  ),
);

const PID = 4711;
const NOTE_KEY = `viva:refund:${PID}:0:2000`;

/** Listing double for the seeded row (order 9000, payment viva-txn-abc), shaped like the probe fixture. */
function mockListing(refunds: { id: string; amountMinor: number; merchantTrns: string | null }[] | 'fail') {
  const icpt = agent.get(DEMO_LEGACY_HOST).intercept({ path: '/api/transactions?ordercode=9000', method: 'GET' });
  if (refunds === 'fail') {
    icpt.reply(500, 'Internal Server Error').persist();
    return;
  }
  const parent = (LISTING_FIXTURE.Transactions as any[]).find((r) => r.ParentId === null);
  const tpl = (LISTING_FIXTURE.Transactions as any[]).find((r) => r.ParentId !== null);
  const base = { CurrencyCode: '826', Order: { OrderCode: '9000' } };
  icpt.reply(
    200,
    {
      ...LISTING_FIXTURE,
      Transactions: [
        { ...parent, ...base, TransactionId: 'viva-txn-abc', Amount: 20 },
        ...refunds.map((r) => ({
          ...tpl,
          ...base,
          TransactionId: r.id,
          ParentId: 'viva-txn-abc',
          Amount: -r.amountMinor / 100,
          MerchantTrns: r.merchantTrns,
        })),
      ],
    },
    { headers: { 'content-type': 'application/json' } },
  );
}

/** Captured row carrying a `started` note from an earlier attempt of `noteAmount`. */
async function seedStarted(
  stateMachine: ReturnType<typeof makeMockStateMachine>,
  noteAmount = 2000,
  rowOverrides: Record<string, unknown> = {},
) {
  await seedCapturedRow(stateMachine, PID);
  const row = stateMachine.rows.get(`1:${PID}`)!;
  stateMachine.rows.set(`1:${PID}`, {
    ...row,
    ...rowOverrides,
    metadata: {
      ...row.metadata,
      refundAttempt: { key: NOTE_KEY, amountMinor: noteAmount, startedAt: '2026-10-25T00:00:00Z', state: 'started' },
    },
  } as any);
}

/** undici fetch failure as thrown in production: TypeError('fetch failed') whose cause carries the system code. */
function mockRefundNetworkError(code: string, times = 1) {
  agent.get(DEMO_LEGACY_HOST)
    .intercept({ path: /\/api\/transactions\//, method: 'DELETE' })
    .replyWithError(Object.assign(new Error(`${code} (test)`), { code }))
    .times(times);
}

function refund(amount = 2000) {
  return (vivaPaymentMethodHandler as any)
    .createRefundFn(makeCtx(), { amount, lines: [] }, amount, makeOrder(), { id: PID, amount: 2000, state: 'Settled', metadata: {} }, {})
    .catch((e: any) => e);
}

const noteState = (sm: ReturnType<typeof makeMockStateMachine>) =>
  (sm.rows.get(`1:${PID}`)!.metadata as any).refundAttempt.state;

/** UNCONFIRMED, no identifiers in the message nor in the log (host rule: no ids in logs). */
function expectUnconfirmed(err: any, ids: string[] = []) {
  expect(err).toBeInstanceOf(VivaPluginError);
  expect(err.code).toBe('VIVA_REFUND_UNCONFIRMED');
  expect(err.retryable).toBe(false);
  // Neutral wording: the host decides where staff refund; the plugin only says check Viva.
  expect(err.message).toContain('may already have gone through at Viva');
  expect(err.message).toContain('Check the Viva dashboard before doing anything else');
  expect(err.message).not.toMatch(/retry this same refund|refund twice|outside Vendure|retry with/i);
  for (const id of [String(PID), 'viva-txn-abc', 'viva:refund:', ...ids]) expect(err.message).not.toContain(id);
  const logged = vi.mocked(Logger.warn).mock.calls.map((c) => String(c[0])).join('\n');
  expect(logged).toContain('[createRefund]');
  for (const id of [String(PID), 'viva-txn-abc', 'viva:refund:', ...ids]) expect(logged).not.toContain(id);
}

describe('#4 createRefund — VIVA_REFUND_UNCONFIRMED vs VIVA_REFUND_REJECTED', () => {
  it('started note + no Viva order code → UNCONFIRMED', async () => {
    const { stateMachine } = setupHandler();
    await seedStarted(stateMachine, 2000, { vivaOrderCode: null });
    expectUnconfirmed(await refund());
  });

  it('started note + listing fails (Viva 500) → UNCONFIRMED, note stays started', async () => {
    const { stateMachine } = setupHandler();
    await seedStarted(stateMachine);
    mockListing('fail');
    expectUnconfirmed(await refund());
    expect(noteState(stateMachine)).toBe('started');
  });

  it('started note + two refunds tagged with the note key → UNCONFIRMED', async () => {
    const { stateMachine } = setupHandler();
    await seedStarted(stateMachine);
    mockListing([
      { id: 'ours-a', amountMinor: 2000, merchantTrns: NOTE_KEY },
      { id: 'ours-b', amountMinor: 2000, merchantTrns: NOTE_KEY },
    ]);
    const err = await refund();
    expectUnconfirmed(err, ['ours-a', 'ours-b']);
    expect(err.message).toMatch(/2 refunds tagged/);
  });

  it('started note + tagged refund amount != note amount → UNCONFIRMED', async () => {
    const { stateMachine } = setupHandler();
    await seedStarted(stateMachine);
    mockListing([{ id: 'ours-odd', amountMinor: 700, merchantTrns: NOTE_KEY }]);
    expectUnconfirmed(await refund(), ['ours-odd']);
  });

  it('earlier refund landed but this request is for another amount → UNCONFIRMED, names both amounts', async () => {
    const { stateMachine } = setupHandler();
    await seedStarted(stateMachine, 500);
    mockListing([{ id: 'ours-500', amountMinor: 500, merchantTrns: NOTE_KEY }]);
    const err = await refund(2000);
    expectUnconfirmed(err, ['ours-500']);
    expect(err.message).toMatch(/earlier refund of 500 .*this request is for 2000/);
  });

  it('refund DELETE gets Viva 5xx → UNCONFIRMED (was VIVA_AUTH_DOWN); note stays started', async () => {
    const { stateMachine } = setupHandler();
    await seedCapturedRow(stateMachine, PID);
    mockRefundError(503);
    expectUnconfirmed(await refund());
    expect(noteState(stateMachine)).toBe('started');
  });

  it('refund DELETE connection reset after send (ECONNRESET) → UNCONFIRMED; note stays started', async () => {
    const { stateMachine } = setupHandler();
    await seedCapturedRow(stateMachine, PID);
    mockRefundNetworkError('ECONNRESET');
    expectUnconfirmed(await refund());
    expect(noteState(stateMachine)).toBe('started');
  });

  it('refund DELETE never sent (ECONNREFUSED, retried once) → keeps VIVA_REFUND_REJECTED', async () => {
    const { stateMachine } = setupHandler();
    await seedCapturedRow(stateMachine, PID);
    mockRefundNetworkError('ECONNREFUSED', 2);
    const err = await refund();
    expect(err).toBeInstanceOf(VivaPluginError);
    expect(err.code).toBe('VIVA_REFUND_REJECTED');
  });

  it('Viva declines with an HTTP 200 failure body → keeps VIVA_REFUND_REJECTED', async () => {
    const { stateMachine } = setupHandler();
    await seedCapturedRow(stateMachine, PID);
    const { _meta, ...body } = REFUND_200_FAILURE;
    agent.get(DEMO_LEGACY_HOST)
      .intercept({ path: /\/api\/transactions\//, method: 'DELETE' })
      .reply(200, body, { headers: { 'content-type': 'application/json' } });
    const err = await refund();
    expect(err).toBeInstanceOf(VivaPluginError);
    expect(err.code).toBe('VIVA_REFUND_REJECTED');
    // Viva's reason survives; the transaction id in its ErrorText does not.
    expect(err.message).toContain('PaymentsRefundFailedTotalAmountExceeded');
    expect(err.message).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-/i);
  });
});

describe('log guard — no identifiers in any log line', () => {
  it('reconcile refusal, 5xx, decline and success log no ids at any level', async () => {
    const levels = ['error', 'warn', 'info', 'verbose', 'debug'] as const;
    for (const l of levels) vi.spyOn(Logger, l).mockReturnValue(undefined);
    const { strategy, stateMachine } = setupHandler();
    await seedToken(strategy);

    // reconcile refusal: two refunds tagged with the note key
    await seedStarted(stateMachine);
    mockListing([
      { id: 'ours-a', amountMinor: 2000, merchantTrns: NOTE_KEY },
      { id: 'ours-b', amountMinor: 2000, merchantTrns: NOTE_KEY },
    ]);
    expect((await refund()).code).toBe('VIVA_REFUND_UNCONFIRMED');
    // 5xx
    stateMachine.rows.clear();
    await seedCapturedRow(stateMachine, PID);
    mockRefundError(503);
    expect((await refund()).code).toBe('VIVA_REFUND_UNCONFIRMED');
    // decline (HTTP 200 failure body; ErrorText names a transaction UUID)
    stateMachine.rows.clear();
    await seedCapturedRow(stateMachine, PID);
    const { _meta, ...body } = REFUND_200_FAILURE;
    agent.get(DEMO_LEGACY_HOST)
      .intercept({ path: /\/api\/transactions\//, method: 'DELETE' })
      .reply(200, body, { headers: { 'content-type': 'application/json' } });
    expect((await refund()).code).toBe('VIVA_REFUND_REJECTED');
    // success
    stateMachine.rows.clear();
    await seedCapturedRow(stateMachine, PID);
    mockRefundSuccess();
    expect((await refund()).state).toBe('Settled');

    const logged = levels.flatMap((l) => vi.mocked(Logger[l]).mock.calls.map((c) => String(c[0])));
    expect(logged.length).toBeGreaterThan(0);
    for (const line of logged) {
      expect(line).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i);
      for (const id of [String(PID), 'viva-txn-abc', 'refund-txn-xyz', 'ours-a', 'ours-b', 'viva:refund:', '9000', 'merchant-uuid']) {
        expect(line).not.toContain(id);
      }
    }
  });
});
