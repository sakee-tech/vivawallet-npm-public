/**
 * test/plugin/refund-idempotency.integration.test.ts — issue #2 + #3 acceptance.
 *
 * #2: a refund whose Viva call succeeded but whose caller transaction then
 * failed at COMMIT must not move money twice when the admin retries.
 * #3: a second partial refund must be allowed (status partially_refunded), and
 * the row ends `refunded` once cumulative refunds reach the payment amount.
 *
 * TIER: HTTP-boundary test. Real: booted Vendure, real Postgres, real
 * PaymentService.createRefund → real handler → real StateMachineService →
 * real Refund FSM + rows, real COMMIT/ROLLBACK. Test double: ONLY Viva's
 * legacy host (MockAgent), which mimics the probe-verified idempotencyKey
 * behaviour (same key → same TransactionId; scripts/viva-refund-cap-probe.ts,
 * 2026-10-24) and serves GET /api/transactions?ordercode= in the shape of the
 * real probe capture (core fixture transactions-ordercode-3445737288589019-tagged.json:
 * each row carries MerchantTrns, the tag sent on its DELETE or null) for the #2
 * follow-up reconcile. The DELETE double rejects any refund whose merchantTrns
 * is not its idempotencyKey. Real-Viva dedupe itself is proven by that
 * probe, not here.
 *
 * Deliberately NOT skipIf: an unreachable Postgres fails this suite.
 */

import { readFileSync } from 'node:fs';
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { setGlobalDispatcher, getGlobalDispatcher, MockAgent } from 'undici';
import type { Dispatcher } from 'undici';
import { parse } from 'graphql';
import { createTestEnvironment, registerInitializer, PostgresInitializer, testConfig } from '@vendure/testing';
import type { TestServer, SimpleGraphQLClient } from '@vendure/testing';
import {
  DefaultLogger,
  LogLevel,
  LanguageCode,
  mergeConfig,
  PaymentService,
  RequestContextService,
  OrderService,
  TransactionalConnection,
  Order,
  Payment,
  Refund,
} from '@vendure/core';
import { Payments } from '@sakeetech/viva-payments-core/payments';
import { BasicAuthClient } from '@sakeetech/viva-payments-core/legacy';
import { checkPgReachable } from '../helpers/db.js';
import { VivaPaymentPlugin } from '../../src/plugin.js';
import { _testInjectDeps } from '../../src/payment-method-handler.js';
import { StateMachineService } from '../../src/services/state-machine.service.js';
import { VivaTransaction } from '../../src/entities/viva-transaction.entity.js';

/** Real probe capture of GET /api/transactions?ordercode= with MerchantTrns tags (Viva demo, 2026-10-25). */
const LISTING_FIXTURE = JSON.parse(
  readFileSync(
    new URL(
      '../../../viva-payments-core/test/payments/fixtures/transactions-ordercode-3445737288589019-tagged.json',
      import.meta.url,
    ),
    'utf8',
  ),
);

const DEMO_AUTH_HOST ='https://demo-accounts.vivapayments.com';
const DEMO_LEGACY_HOST = 'https://demo.vivapayments.com';
const MERCHANT_UUID = 'merchant-uuid-issue-2';

function resolvePgConnection() {
  const url = process.env['DATABASE_URL'];
  if (url) {
    const u = new URL(url);
    return {
      host: u.hostname || 'localhost',
      port: u.port ? Number(u.port) : 5432,
      username: decodeURIComponent(u.username) || 'postgres',
      password: decodeURIComponent(u.password) || '',
    };
  }
  return { host: 'localhost', port: 5432, username: process.env['USER'] ?? 'postgres', password: '' };
}

registerInitializer('postgres', new PostgresInitializer());

let server: TestServer;
let adminClient: SimpleGraphQLClient;
let mockAgent: MockAgent;
let originalDispatcher: Dispatcher;

describe('#2/#3 refunds (HTTP-boundary, real Postgres)', () => {
  beforeAll(async () => {
    if (!(await checkPgReachable())) {
      throw new Error('Postgres unreachable — start it (DATABASE_URL or $USER@localhost:5432) and re-run.');
    }
    originalDispatcher = getGlobalDispatcher();
    mockAgent = new MockAgent();
    mockAgent
      .get(DEMO_AUTH_HOST)
      .intercept({ path: '/connect/token', method: 'POST' })
      .reply(200, { access_token: 'tok', expires_in: 3600, token_type: 'Bearer' }, {
        headers: { 'content-type': 'application/json' },
      })
      .persist();
    setGlobalDispatcher(mockAgent);

    const config = mergeConfig(testConfig, {
      // boots-in-vendure.test.ts holds testConfig's 3050; vitest runs files in parallel.
      apiOptions: { port: 3051 },
      logger: new DefaultLogger({ level: LogLevel.Error }),
      plugins: [
        VivaPaymentPlugin.init({
          mode: 'isv',
          clientId: 'it-id',
          clientSecret: 'it-secret',
          environment: 'demo',
          webhookVerificationKey: 'verify-key',
          legacyMerchantId: 'it-merchant',
          legacyApiKey: 'it-key',
          successUrl: 'https://example.com/success',
          failureUrl: 'https://example.com/failure',
          onboardingReturnUrl: 'https://example.com/onboarding-return',
        }),
      ],
    });
    config.dbConnectionOptions = { type: 'postgres', ...resolvePgConnection(), synchronize: true };

    const env = createTestEnvironment(config);
    server = env.server;
    adminClient = env.adminClient;
    await server.init({
      initialData: {
        defaultLanguage: LanguageCode.en,
        defaultZone: 'Europe',
        countries: [{ name: 'United Kingdom', code: 'GB', zone: 'Europe' }],
        taxRates: [{ name: 'Standard Tax', percentage: 20 }],
        shippingMethods: [],
        collections: [],
        paymentMethods: [],
      },
      productsCsvPath: undefined as unknown as string,
      customerCount: 0,
    });
  }, 120_000);

  afterAll(async () => {
    vi.restoreAllMocks();
    if (server) await server.destroy();
    if (originalDispatcher) setGlobalDispatcher(originalDispatcher);
    await mockAgent?.close();
  });

  let paymentMethodCreated = false;
  let seedCount = 0;

  /**
   * Seed a viva PaymentMethod (once), an order, a Settled payment and a viva
   * row with `status`, plus a Viva legacy-host double for that row's own
   * transaction id (records each DELETE, dedupes on idempotencyKey like real
   * Viva). Injects the REAL StateMachineService.
   */
  async function seedPayment(total: number, status = 'captured', extraMeta: Record<string, unknown> = {}) {
    const n = ++seedCount;
    const txnId = `aaaaaaaa-2222-4222-8222-${String(n).padStart(12, '0')}`;
    const paymentService = server.app.get(PaymentService);
    const orderService = server.app.get(OrderService);
    const connection = server.app.get(TransactionalConnection);
    const ctx = await server.app.get(RequestContextService).create({ apiType: 'admin' });

    if (!paymentMethodCreated) {
      paymentMethodCreated = true;
      await adminClient.asSuperAdmin();
      await adminClient.query(
        parse(`
          mutation {
            createPaymentMethod(input: {
              code: "viva", enabled: true,
              translations: [{ languageCode: en, name: "Viva", description: "" }],
              handler: { code: "viva", arguments: [] }
            }) { id }
          }
        `),
      );
    }
    const order = await orderService.create(ctx);
    order.subTotal = total;
    order.subTotalWithTax = total;
    await connection.getRepository(ctx, Order).save(order);
    const payment = await paymentService.create(ctx, { method: 'viva', amount: total, metadata: {} });
    await connection.getRepository(ctx, Order).createQueryBuilder().relation('payments').of(order).add(payment);
    await connection.getRepository(ctx, Payment).update(payment.id, { state: 'Settled' });

    const vivaRepo = connection.getRepository(ctx, VivaTransaction);
    await vivaRepo.save(
      vivaRepo.create({
        channelId: ctx.channelId as any,
        paymentId: payment.id as any,
        status: status as any,
        vivaOrderCode: String(6652359299366000n + BigInt(n)),
        vivaTransactionId: txnId,
        amountMinor: String(total),
        currencyCode: 'GBP',
        isvAmountMinor: '0',
        metadata: { vivaMerchantId: MERCHANT_UUID, ...extraMeta },
      }),
    );
    const orderCode = String(6652359299366000n + BigInt(n));

    const sentKeys: string[] = [];
    /** merchantTrns of each DELETE, in order. */
    const sentTrns: (string | null)[] = [];
    const txnByKey = new Map<string, string>();
    /** Refunds that moved money at "Viva" (feeds the listing). */
    const vivaRefunds: { id: string; amountMinor: number; merchantTrns: string | null }[] = [];
    /** Knobs: fail the next N DELETEs before they land (503); listing behaviour. */
    const viva = { failDeletes: 0, listingFails: false, extraListed: [] as { id: string; amountMinor: number; merchantTrns: string | null }[] };
    mockAgent
      .get(DEMO_LEGACY_HOST)
      .intercept({ path: new RegExp(`^/api/transactions/${txnId}`), method: 'DELETE' })
      .reply((opts) => {
        const q = new URL(`http://x${opts.path}`).searchParams;
        const key = q.get('idempotencyKey') ?? '';
        sentKeys.push(key);
        sentTrns.push(q.get('merchantTrns'));
        // #2: every refund must be tagged with its own key, untruncated.
        if (q.get('merchantTrns') !== key) {
          return { statusCode: 400, data: `merchantTrns ${q.get('merchantTrns')} != idempotencyKey ${key}` };
        }
        if (viva.failDeletes > 0) {
          viva.failDeletes--;
          return { statusCode: 503, data: 'Service Unavailable' };
        }
        if (!txnByKey.has(key)) {
          txnByKey.set(key, `refund-txn-${n}-${txnByKey.size + 1}`);
          vivaRefunds.push({ id: txnByKey.get(key)!, amountMinor: Number(q.get('amount')), merchantTrns: key });
        }
        return { statusCode: 200, responseOptions: { headers: { 'content-type': 'application/json' } }, data: JSON.stringify({
          TransactionId: txnByKey.get(key),
          StatusId: 'F',
          Amount: Number(q.get('amount')) / 100,
          CurrencyCode: '826',
          ErrorCode: 0,
          ErrorText: null,
          Success: true,
        }) };
      })
      .persist();

    // GET /api/transactions?ordercode= — shape from the real probe capture
    // (core fixture transactions-ordercode-3445737288589019-tagged.json): the payment
    // row plus one row per refund (ParentId = payment, negative Amount, F,
    // MerchantTrns = the tag sent on its DELETE, null for dashboard refunds).
    mockAgent
      .get(DEMO_LEGACY_HOST)
      .intercept({ path: `/api/transactions?ordercode=${orderCode}`, method: 'GET' })
      .reply(() => {
        if (viva.listingFails) return { statusCode: 500, data: 'Internal Server Error' };
        const base = { CurrencyCode: '826', Order: { OrderCode: orderCode } };
        const parent = (LISTING_FIXTURE.Transactions as any[]).find((r) => r.ParentId === null);
        const refundTpl = (LISTING_FIXTURE.Transactions as any[]).find((r) => r.ParentId !== null);
        const rows = [
          { ...parent, ...base, TransactionId: txnId, Amount: total / 100 },
          ...[...vivaRefunds, ...viva.extraListed].map((r) => ({
            ...refundTpl,
            ...base,
            TransactionId: r.id,
            ParentId: txnId,
            Amount: -r.amountMinor / 100,
            MerchantTrns: r.merchantTrns,
          })),
        ];
        return {
          statusCode: 200,
          responseOptions: { headers: { 'content-type': 'application/json' } },
          data: JSON.stringify({ ...LISTING_FIXTURE, Transactions: rows }),
        };
      })
      .persist();

    const fetchImpl = ((url: string, init: any) =>
      fetch(url, { ...init, dispatcher: mockAgent } as any)) as any;
    _testInjectDeps({
      options: {
        mode: 'isv',
        environment: 'demo',
        reseller: { resellerId: 'reseller-it', merchantId: MERCHANT_UUID, resellerApiKey: 'reseller-key' },
      } as any,
      oauth2: {} as any,
      stateMachine: server.app.get(StateMachineService), // REAL service + real DB
      isvPayments: new Payments({ mode: 'isv', client: {} as any }),
      resellerLegacyClient: new BasicAuthClient({
        authVariant: 'reseller',
        environment: 'demo',
        resellerId: 'reseller-it',
        merchantId: MERCHANT_UUID,
        resellerApiKey: 'reseller-key',
        dispatcher: mockAgent as unknown as Dispatcher,
        fetchImpl,
        retryBackoffsMs: [0, 0, 0],
        jitterRatio: 0,
      } as any),
    });

    const refund = (amount: number) =>
      connection.withTransaction(ctx, (txCtx) =>
        paymentService.createRefund(txCtx, { paymentId: payment.id, amount, reason: 'it' } as any, order, payment),
      );
    const loadRow = () => vivaRepo.findOneOrFail({ where: { paymentId: payment.id as any } });
    const rowStatus = async () => (await loadRow()).status;
    const settledRefunds = () =>
      connection.getRepository(ctx, Refund).find({ where: { paymentId: payment.id, state: 'Settled' } });
    return {
      ctx, connection, paymentService, order, payment, sentKeys, sentTrns, txnByKey, vivaRefunds, viva,
      refund, rowStatus, loadRow, settledRefunds,
    };
  }

  /**
   * Make the caller's OUTER COMMIT fail once (nested savepoints pass through).
   * `when` gates it to commits after Viva refunded — the handler's own
   * refund-note transaction also commits at depth 1, BEFORE the Viva call.
   */
  async function failNextCommit(connection: TransactionalConnection, when: () => boolean) {
    const probeRunner = connection.rawConnection.createQueryRunner();
    const runnerProto = Object.getPrototypeOf(probeRunner);
    await probeRunner.release();
    const realCommit = runnerProto.commitTransaction;
    const state = { armed: true };
    const spy = vi.spyOn(runnerProto, 'commitTransaction').mockImplementation(async function (this: any) {
      if (state.armed && this.transactionDepth === 1 && when()) {
        state.armed = false;
        throw new Error('injected COMMIT failure');
      }
      return realCommit.call(this);
    });
    return { state, restore: () => spy.mockRestore() };
  }

  /** Key of the `started` note below; Viva rows tagged with it are that attempt. */
  const earlierKey = (amount: number) => `viva:refund:earlier:0:${amount}`;
  /** A `started` note left by an earlier attempt. */
  const startedNote = (amount: number) => ({
    refundAttempt: {
      key: earlierKey(amount),
      amountMinor: amount,
      startedAt: '2026-10-24T17:03:00.000Z',
      state: 'started',
    },
  });

  it('#2: Viva refunded, COMMIT fails → note survives; retry adopts the listed refund, no second DELETE', async () => {
    const REFUND = 300;
    const { connection, payment, sentKeys, sentTrns, vivaRefunds, refund, rowStatus, loadRow, settledRefunds } =
      await seedPayment(1000);

    // --- Attempt 1: Viva refunds, then the caller's COMMIT fails → rollback.
    const commit = await failNextCommit(connection, () => vivaRefunds.length > 0);
    await expect(refund(REFUND)).rejects.toThrow('injected COMMIT failure');
    expect(commit.state.armed).toBe(false); // the failure really fired at COMMIT
    commit.restore();

    expect(await settledRefunds()).toHaveLength(0);
    expect(await rowStatus()).toBe('captured');
    // The started note was committed on its own connection — it survived.
    const key = `viva:refund:${payment.id}:0:${REFUND}`;
    expect((await loadRow()).metadata['refundAttempt']).toMatchObject({ key, amountMinor: REFUND, state: 'started' });
    expect(sentKeys).toEqual([key]);
    expect(sentTrns).toEqual([key]); // tagged with the full key
    expect(vivaRefunds).toHaveLength(1);

    // --- Attempt 2: listing shows Viva's refund unknown to Vendure → adopt.
    const result = (await refund(REFUND)) as Refund;
    expect(result.state).toBe('Settled');
    expect(result.metadata).toEqual({ vivaRefundResponse: { transactionId: vivaRefunds[0]!.id } });
    expect(sentKeys).toHaveLength(1); // NO second DELETE

    const refunds = await settledRefunds();
    expect(refunds).toHaveLength(1);
    expect(refunds[0]!.total).toBe(REFUND);
    const row = await loadRow();
    expect(row.status).toBe('partially_refunded');
    expect(row.metadata['refundAttempt']).toMatchObject({ key, state: 'done' });
    expect(row.metadata['lastRefundTransactionId']).toBe(vivaRefunds[0]!.id);
  });

  it('#2: call never landed (Viva 503) → listing empty → retry resends with the SAME key; one Refund', async () => {
    const REFUND = 300;
    const { payment, sentKeys, vivaRefunds, viva, refund, loadRow, settledRefunds } = await seedPayment(1000);

    viva.failDeletes = 1;
    await expect(refund(REFUND)).rejects.toMatchObject({ code: 'VIVA_REFUND_UNCONFIRMED' });
    expect(vivaRefunds).toHaveLength(0);
    expect((await loadRow()).metadata['refundAttempt']).toMatchObject({ state: 'started' });

    expect(((await refund(REFUND)) as Refund).state).toBe('Settled');
    const key = `viva:refund:${payment.id}:0:${REFUND}`;
    expect(sentKeys).toEqual([key, key]);
    expect(vivaRefunds).toHaveLength(1);
    expect(await settledRefunds()).toHaveLength(1);
    expect((await loadRow()).metadata['refundAttempt']).toMatchObject({ key, state: 'done' });
  });

  it('#2/#4: started note + listing fails → VIVA_REFUND_UNCONFIRMED without identifiers, no DELETE, note stays started', async () => {
    const { payment, sentKeys, viva, refund, settledRefunds, loadRow } = await seedPayment(1000, 'captured', startedNote(300));
    viva.listingFails = true;
    const err = await refund(300).then(
      () => new Error('refund unexpectedly succeeded'),
      (e: unknown) => e as Error & { code?: string },
    );
    expect(err.code).toBe('VIVA_REFUND_UNCONFIRMED');
    expect(err.message).not.toContain(`payment ${String(payment.id)}`);
    expect(err.message).not.toContain(earlierKey(300));
    expect(err.message).toMatch(/Viva dashboard/);
    expect(sentKeys).toHaveLength(0);
    expect(await settledRefunds()).toHaveLength(0);
    expect((await loadRow()).metadata['refundAttempt']).toMatchObject({ key: earlierKey(300), state: 'started' });
  });

  it('#2: started note + our tagged refund of a different amount than this request → refused, no DELETE', async () => {
    const { payment, sentKeys, viva, refund, settledRefunds } = await seedPayment(1000, 'captured', startedNote(500));
    viva.extraListed.push({ id: 'ours-refund-500', amountMinor: 500, merchantTrns: earlierKey(500) });
    const err = await refund(300).then(
      () => new Error('refund unexpectedly succeeded'),
      (e: unknown) => e as Error & { code?: string },
    );
    expect(err.code).toBe('VIVA_REFUND_UNCONFIRMED');
    expect(err.message).toContain('may already have gone through at Viva');
    expect(err.message).not.toContain(`payment ${String(payment.id)}`);
    expect(err.message).not.toContain('ours-refund-500');
    expect(err.message).toMatch(/earlier refund of 500 .*this request is for 300/);
    expect(err.message).not.toMatch(/retry|outside Vendure/i);
    expect(sentKeys).toHaveLength(0);
    expect(await settledRefunds()).toHaveLength(0);
  });

  it('#2: started note + only a dashboard refund (merchantTrns null) → ignored; resend, one DELETE, Settled', async () => {
    const { payment, sentKeys, viva, refund, settledRefunds } = await seedPayment(1000, 'captured', startedNote(300));
    viva.extraListed.push({ id: 'dashboard-refund-300', amountMinor: 300, merchantTrns: null });
    expect(((await refund(300)) as Refund).state).toBe('Settled');
    expect(sentKeys).toEqual([`viva:refund:${payment.id}:0:300`]);
    expect(await settledRefunds()).toHaveLength(1);
  });

  it('#2: started note + dashboard refund AND our tagged refund → adopt ours, no DELETE', async () => {
    const { sentKeys, viva, refund, settledRefunds, loadRow } = await seedPayment(1000, 'captured', startedNote(300));
    viva.extraListed.push(
      { id: 'dashboard-refund-300', amountMinor: 300, merchantTrns: null },
      { id: 'ours-refund-300', amountMinor: 300, merchantTrns: earlierKey(300) },
    );
    const result = (await refund(300)) as Refund;
    expect(result.state).toBe('Settled');
    expect(result.metadata).toEqual({ vivaRefundResponse: { transactionId: 'ours-refund-300' } });
    expect(sentKeys).toHaveLength(0);
    expect(await settledRefunds()).toHaveLength(1);
    expect((await loadRow()).metadata['refundAttempt']).toMatchObject({ key: earlierKey(300), state: 'done' });
  });

  it('#2: started note + two refunds tagged with the note key → refused, no DELETE', async () => {
    const { sentKeys, viva, refund, settledRefunds } = await seedPayment(1000, 'captured', startedNote(300));
    viva.extraListed.push(
      { id: 'ours-a', amountMinor: 300, merchantTrns: earlierKey(300) },
      { id: 'ours-b', amountMinor: 300, merchantTrns: earlierKey(300) },
    );
    await expect(refund(300)).rejects.toThrow(/2 refunds tagged/);
    await expect(refund(300)).rejects.toMatchObject({ code: 'VIVA_REFUND_UNCONFIRMED' });
    expect(sentKeys).toHaveLength(0);
    expect(await settledRefunds()).toHaveLength(0);
  });

  it('#2: success leaves the note done and keeps other metadata keys (stale-snapshot gotcha)', async () => {
    const { payment, refund, loadRow } = await seedPayment(1000, 'captured', { someOtherKey: 'keep-me' });
    expect(((await refund(300)) as Refund).state).toBe('Settled');
    const meta = (await loadRow()).metadata;
    expect(meta['refundAttempt']).toMatchObject({ key: `viva:refund:${payment.id}:0:300`, amountMinor: 300, state: 'done' });
    expect(meta['vivaMerchantId']).toBe(MERCHANT_UUID);
    expect(meta['someOtherKey']).toBe('keep-me');
    expect(meta['refundedAmountMinor']).toBe(300);
  });

  it('#3: two sequential £3 partials both succeed with distinct keys; status stays partially_refunded', async () => {
    const { connection, ctx, payment, sentKeys, refund, rowStatus } = await seedPayment(1000);

    expect(((await refund(300)) as Refund).state).toBe('Settled');
    expect(await rowStatus()).toBe('partially_refunded');

    expect(((await refund(300)) as Refund).state).toBe('Settled');
    expect(await rowStatus()).toBe('partially_refunded');

    expect(sentKeys).toEqual([`viva:refund:${payment.id}:0:300`, `viva:refund:${payment.id}:300:300`]);
    const refunds = await connection.getRepository(ctx, Refund).find({ where: { paymentId: payment.id } });
    expect(refunds.map((r) => r.state)).toEqual(['Settled', 'Settled']);
  });

  it('#3: £3 + £7 on £10 ends refunded', async () => {
    const { refund, rowStatus } = await seedPayment(1000);
    expect(((await refund(300)) as Refund).state).toBe('Settled');
    expect(await rowStatus()).toBe('partially_refunded');
    expect(((await refund(700)) as Refund).state).toBe('Settled');
    expect(await rowStatus()).toBe('refunded');
  });

  it('#3: refund on a refunded row is still rejected, naming the actual status; Viva not called', async () => {
    const { refund, sentKeys } = await seedPayment(1000, 'refunded');
    await expect(refund(100)).rejects.toThrow(/status: refunded/);
    expect(sentKeys).toHaveLength(0);
  });
});
