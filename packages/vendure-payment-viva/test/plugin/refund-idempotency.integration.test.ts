/**
 * test/plugin/refund-idempotency.integration.test.ts — issue #2 acceptance.
 *
 * A refund whose Viva call succeeded but whose caller transaction then failed
 * at COMMIT must not move money twice when the admin retries.
 *
 * TIER: HTTP-boundary test. Real: booted Vendure, real Postgres, real
 * PaymentService.createRefund → real handler → real StateMachineService →
 * real Refund FSM + rows, real COMMIT/ROLLBACK. Test double: ONLY Viva's
 * legacy host (MockAgent), which mimics the probe-verified idempotencyKey
 * behaviour (same key → same TransactionId; scripts/viva-refund-cap-probe.ts,
 * 2026-10-24). Real-Viva dedupe itself is proven by that probe, not here.
 *
 * Deliberately NOT skipIf: an unreachable Postgres fails this suite.
 */

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

const DEMO_AUTH_HOST = 'https://demo-accounts.vivapayments.com';
const DEMO_LEGACY_HOST = 'https://demo.vivapayments.com';
const VIVA_TXN_ID = 'aaaaaaaa-2222-4222-8222-000000000002';
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

describe('#2 refund idempotency across a failed COMMIT (HTTP-boundary, real Postgres)', () => {
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

  it('COMMIT fails after Viva refunded → retry sends the SAME idempotencyKey; one Refund row', async () => {
    const TOTAL = 1000;
    const REFUND = 300;
    const paymentService = server.app.get(PaymentService);
    const orderService = server.app.get(OrderService);
    const connection = server.app.get(TransactionalConnection);
    const ctx = await server.app.get(RequestContextService).create({ apiType: 'admin' });

    // --- Seed: viva PaymentMethod, order, Settled payment, captured viva row ---
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
    const order = await orderService.create(ctx);
    order.subTotal = TOTAL;
    order.subTotalWithTax = TOTAL;
    await connection.getRepository(ctx, Order).save(order);
    const payment = await paymentService.create(ctx, { method: 'viva', amount: TOTAL, metadata: {} });
    await connection.getRepository(ctx, Order).createQueryBuilder().relation('payments').of(order).add(payment);
    await connection.getRepository(ctx, Payment).update(payment.id, { state: 'Settled' });

    const vivaRepo = connection.getRepository(ctx, VivaTransaction);
    await vivaRepo.save(
      vivaRepo.create({
        channelId: ctx.channelId as any,
        paymentId: payment.id as any,
        status: 'captured' as any,
        vivaOrderCode: '6652359299366002',
        vivaTransactionId: VIVA_TXN_ID,
        amountMinor: String(TOTAL),
        currencyCode: 'GBP',
        isvAmountMinor: '0',
        metadata: { vivaMerchantId: MERCHANT_UUID },
      }),
    );

    // --- Viva double: records each DELETE, dedupes on idempotencyKey like real Viva ---
    const sentKeys: string[] = [];
    const txnByKey = new Map<string, string>();
    mockAgent
      .get(DEMO_LEGACY_HOST)
      .intercept({ path: new RegExp(`^/api/transactions/${VIVA_TXN_ID}`), method: 'DELETE' })
      .reply(200, (opts) => {
        const q = new URL(`http://x${opts.path}`).searchParams;
        const key = q.get('idempotencyKey') ?? '';
        sentKeys.push(key);
        if (!txnByKey.has(key)) txnByKey.set(key, `refund-txn-${txnByKey.size + 1}`);
        return JSON.stringify({
          TransactionId: txnByKey.get(key),
          StatusId: 'F',
          Amount: Number(q.get('amount')) / 100,
          CurrencyCode: '826',
          ErrorCode: 0,
          ErrorText: null,
          Success: true,
        });
      }, { headers: { 'content-type': 'application/json' } })
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

    const input = { paymentId: payment.id, amount: REFUND, reason: 'issue-2' } as any;

    // --- Attempt 1: inject failure at the OUTER COMMIT (depth 1; nested
    // savepoint releases at depth > 1 pass through). Everything rolls back.
    const probeRunner = connection.rawConnection.createQueryRunner();
    const runnerProto = Object.getPrototypeOf(probeRunner);
    await probeRunner.release();
    const realCommit = runnerProto.commitTransaction;
    let armed = true;
    const commitSpy = vi.spyOn(runnerProto, 'commitTransaction').mockImplementation(async function (this: any) {
      if (armed && this.transactionDepth === 1) {
        armed = false;
        throw new Error('injected COMMIT failure');
      }
      return realCommit.call(this);
    });

    await expect(
      connection.withTransaction(ctx, (txCtx) => paymentService.createRefund(txCtx, input, order, payment)),
    ).rejects.toThrow('injected COMMIT failure');
    expect(armed).toBe(false); // the failure really fired at COMMIT
    commitSpy.mockRestore();

    expect(await connection.getRepository(ctx, Refund).count({ where: { paymentId: payment.id } })).toBe(0);
    const rowAfterRollback = await vivaRepo.findOneOrFail({ where: { paymentId: payment.id as any } });
    expect(rowAfterRollback.status).toBe('captured');

    // --- Attempt 2: admin retries the same refund; COMMIT succeeds ---
    const result = await connection.withTransaction(ctx, (txCtx) =>
      paymentService.createRefund(txCtx, input, order, payment),
    );
    expect((result as Refund).state).toBe('Settled');

    // Both DELETEs carried the SAME key → Viva returned the original refund.
    expect(sentKeys).toHaveLength(2);
    expect(sentKeys[0]).toBe(`viva:refund:${payment.id}:0:${REFUND}`);
    expect(sentKeys[1]).toBe(sentKeys[0]);
    expect(txnByKey.size).toBe(1); // one refund at "Viva"

    const refunds = await connection.getRepository(ctx, Refund).find({ where: { paymentId: payment.id } });
    expect(refunds).toHaveLength(1);
    expect(refunds[0]!.total).toBe(REFUND);
    expect(refunds[0]!.state).toBe('Settled');
  });
});
