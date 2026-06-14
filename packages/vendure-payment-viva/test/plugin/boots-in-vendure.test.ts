/**
 * test/plugin/boots-in-vendure.test.ts — "does it actually boot?" regression guard.
 *
 * Covers the two 0.2.2 bootstrap-blocking defects (public #5 / #6, fixed in
 * 0.2.3, commit 095e44c). Both pass `tsc` + every unit test yet crash a real
 * Vendure instance, because they only surface when the NestJS module graph is
 * built and the executable GraphQL schema is assembled:
 *
 *   #5 — @VendurePlugin({ imports: [] }) → Nest DI cannot resolve the core
 *        providers our services inject (TransactionalConnection / OrderService /
 *        PaymentService). Fixed: imports: [PluginCommonModule].
 *
 *   #6 — CancelPaymentError.errorCode typed `String!` instead of `ErrorCode!`
 *        (violates the ErrorResult interface → schema build fails), and the
 *        resolver's granular reason codes (VIVA_*, AUTHORIZATION_FAILED) not
 *        registered as ErrorCode enum members (→ runtime serialization throws).
 *        Fixed: errorCode: ErrorCode! + extend enum ErrorCode { … }.
 *
 * Unlike test/plugin/bootstrap.test.ts (which constructs VivaBootstrap in
 * isolation), this boots the FULL plugin inside a real Vendure application.
 * The plugin's entities use Postgres `jsonb`, so this requires Postgres — it
 * skips gracefully when the DB is unreachable (CI without a DB service), the
 * same contract as the entity tests. pgReachable is top-level awaited BEFORE
 * describe() so the skip is decided at collection time.
 *
 * Network: the boot-time OAuth2 warmup hits the Viva token endpoint over global
 * fetch (undici). We intercept ONLY that host with a MockAgent so the warmup
 * resolves hermetically; net-connect is NOT disabled, so localhost GraphQL
 * traffic to the test server is untouched.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { setGlobalDispatcher, getGlobalDispatcher, MockAgent } from 'undici';
import type { Dispatcher } from 'undici';
import { parse } from 'graphql';
import {
  createTestEnvironment,
  registerInitializer,
  PostgresInitializer,
  testConfig,
} from '@vendure/testing';
import type { TestServer, SimpleGraphQLClient } from '@vendure/testing';
import {
  DefaultLogger,
  LogLevel,
  LanguageCode,
  mergeConfig,
  PaymentService,
  defaultPaymentProcess,
  RequestContextService,
  OrderService,
  TransactionalConnection,
  Order,
  Payment,
} from '@vendure/core';
import { checkPgReachable } from '../helpers/db.js';
import { VivaPaymentPlugin } from '../../src/plugin.js';
import { _testInjectDeps } from '../../src/payment-method-handler.js';
import { VivaApiError } from '@sakeetech/viva-payments-core/errors';
import { vivaPaymentProcess } from '../../src/payment-process.js';
import { StateMachineService } from '../../src/services/state-machine.service.js';
import { VivaTransaction } from '../../src/entities/viva-transaction.entity.js';
import { VivaShopApiResolver } from '../../src/api/shop-api.resolver.js';

// Top-level await — must resolve before describe() is evaluated (vitest collects
// before running beforeAll, so a skip inside beforeAll would be too late).
const pgReachable = await checkPgReachable();

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DEMO_AUTH_HOST = 'https://demo-accounts.vivapayments.com';
const TOKEN_PATH = '/connect/token';

// Granular error codes the cancelPayment resolver can emit — every one must be
// a member of the extended ErrorCode enum or runtime serialization throws.
const EXTENDED_ERROR_CODES = [
  'AUTHORIZATION_FAILED',
  'VIVA_AUTH_DOWN',
  'VIVA_API_ERROR',
  'VIVA_ACCOUNT_NOT_VERIFIED',
  'VIVA_ISV_AMOUNT_TOO_HIGH',
  'VIVA_CHANNEL_MISCONFIGURED',
  'VIVA_ORDER_NOT_FOUND',
  'VIVA_AMOUNT_MISMATCH',
  'VIVA_REFUND_REJECTED',
  'VIVA_FAST_REFUND_INELIGIBLE',
  'VIVA_MODE_MISMATCH',
  'VIVA_PAYMENT_ALREADY_SETTLED',
  'VIVA_PAYMENT_NOT_CANCELLABLE',
  'VIVA_ALREADY_ONBOARDED',
  'VIVA_RESELLER_CREDENTIALS_MISSING',
  'VIVA_SOURCE_CREATION_FAILED',
  'VIVA_INTERNAL_ERROR',
];

// ---------------------------------------------------------------------------
// Postgres connection (mirrors test/helpers/db.ts resolution)
// ---------------------------------------------------------------------------

function resolvePgConnection(): { host: string; port: number; username: string; password: string } {
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
  return {
    host: 'localhost',
    port: 5432,
    username: process.env['USER'] ?? 'postgres',
    password: '',
  };
}

// PostgresInitializer derives the test DB name from this file's name and runs
// DROP/CREATE DATABASE + synchronize, so we get an isolated schema per run.
registerInitializer('postgres', new PostgresInitializer());

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------

let server: TestServer;
let shopClient: SimpleGraphQLClient;
let adminClient: SimpleGraphQLClient;
let mockAgent: MockAgent;
let originalDispatcher: Dispatcher;

describe.skipIf(!pgReachable)('VivaPaymentPlugin boots inside a real Vendure instance', () => {
  beforeAll(async () => {
    // Intercept the Viva OAuth2 token endpoint so the boot warmup resolves
    // without a live network call. Net-connect stays ENABLED for localhost.
    originalDispatcher = getGlobalDispatcher();
    mockAgent = new MockAgent();
    mockAgent
      .get(DEMO_AUTH_HOST)
      .intercept({ path: TOKEN_PATH, method: 'POST' })
      .reply(
        200,
        { access_token: 'tok_boot_smoke', expires_in: 3600, token_type: 'Bearer', scope: 'urn:viva:payments:core' },
        { headers: { 'content-type': 'application/json' } },
      )
      .persist();
    setGlobalDispatcher(mockAgent);

    const config = mergeConfig(testConfig, {
      logger: new DefaultLogger({ level: LogLevel.Error }),
      plugins: [
        VivaPaymentPlugin.init({
          mode: 'isv',
          clientId: 'boot-smoke-id',
          clientSecret: 'boot-smoke-secret',
          environment: 'demo',
          webhookVerificationKey: 'verify-key',
          legacyMerchantId: 'boot-smoke-merchant-uuid',
          legacyApiKey: 'boot-smoke-api-key',
          successUrl: 'https://example.com/success',
          failureUrl: 'https://example.com/failure',
          onboardingReturnUrl: 'https://example.com/onboarding-return',
        }),
      ],
    });
    // Replace the sqljs default outright (mergeConfig would otherwise leave
    // sqljs-only keys behind and confuse the postgres driver).
    config.dbConnectionOptions = {
      type: 'postgres',
      ...resolvePgConnection(),
      synchronize: true,
    };

    const env = createTestEnvironment(config);
    server = env.server;
    shopClient = env.shopClient;
    adminClient = env.adminClient;

    // The actual boot. If #5 regressed → Nest DI error here; if #6's SDL
    // regressed → GraphQL schema-build error here.
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
    if (server) await server.destroy();
    if (originalDispatcher) setGlobalDispatcher(originalDispatcher);
    await mockAgent?.close();
  });

  it('#5 — boots with no NestJS DI error (PluginCommonModule wired)', () => {
    // Reaching this assertion means server.init() resolved: Nest built the full
    // module graph and resolved every provider's injected core service. With
    // imports: [] this point is never reached.
    expect(server.app).toBeDefined();
  });

  it('#6 (schema) — CancelPaymentError.errorCode is ErrorCode!, not String!', async () => {
    const data = await shopClient.query(
      parse(`
        query {
          __type(name: "CancelPaymentError") {
            fields { name type { kind ofType { kind name } } }
          }
        }
      `),
    );

    const fields: Array<{ name: string; type: { kind: string; ofType: { kind: string; name: string } | null } }> =
      data.__type.fields;
    const errorCode = fields.find((f) => f.name === 'errorCode');

    expect(errorCode).toBeDefined();
    // NON_NULL wrapper around the ErrorCode enum — proves it is `ErrorCode!`.
    expect(errorCode!.type.kind).toBe('NON_NULL');
    expect(errorCode!.type.ofType?.kind).toBe('ENUM');
    expect(errorCode!.type.ofType?.name).toBe('ErrorCode');
  });

  it('#6 (schema) — every granular reason code is an ErrorCode enum member', async () => {
    const data = await shopClient.query(
      parse(`
        query {
          __type(name: "ErrorCode") { enumValues { name } }
        }
      `),
    );

    const members: string[] = data.__type.enumValues.map((v: { name: string }) => v.name);
    for (const code of EXTENDED_ERROR_CODES) {
      expect(members).toContain(code);
    }
  });

  // -------------------------------------------------------------------------
  // #10 — Created → Created self-transition must be legal in the live FSM.
  //
  // createPayment returns `state: 'Created'` (D3). PaymentService.createPayment
  // persists the Payment in 'Created' then immediately calls
  // transition(payment, 'Created') — a self-transition the DEFAULT process
  // rejects ("Cannot transition Payment from 'Created' to 'Created'" → 500 →
  // /?paymentInProgress=1). The plugin's configuration() registers
  // vivaPaymentProcess to legalise it.
  //
  // getNextStates(payment) reads the SAME merged `config.transitions[state].to`
  // array that the live transition() consults, so asserting 'Created' ∈
  // getNextStates({state:'Created'}) is equivalent to proving the live
  // Created → Created transition succeeds. This is the guard the handler-seam
  // unit tests (which call createPaymentFn directly, bypassing the FSM) could
  // never provide.
  // -------------------------------------------------------------------------
  it('#10 — the booted payment FSM allows the Created → Created self-transition', () => {
    const paymentService = server.app.get(PaymentService);
    const nextStates = paymentService.getNextStates({ state: 'Created' } as any);

    // The fix: our customPaymentProcess added 'Created' to Created's targets.
    expect(nextStates).toContain('Created');
    // Additive merge — the default outgoing transitions survive (not replaced).
    expect(nextStates).toContain('Settled');
    expect(nextStates).toContain('Cancelled');
  });

  it('#10 — documents WHY: the default process does NOT permit Created → Created', () => {
    // If a future Vendure default ever adds this, the assertion flips and signals
    // that vivaPaymentProcess has become redundant.
    expect(defaultPaymentProcess.transitions!.Created!.to).not.toContain('Created');
  });

  it('#6 (runtime) — cancelPayment serializes a granular ErrorCode without throwing', async () => {
    // Unknown paymentId → resolver returns CancelPaymentError(VIVA_PAYMENT_NOT_CANCELLABLE)
    // before any Viva call. This forces GraphQL to serialize an extended enum
    // member; if it were not a registered member the query would error out.
    const data = await shopClient.query(
      parse(`
        mutation {
          cancelPayment(paymentId: "999999") {
            __typename
            ... on CancelPaymentError { errorCode message }
          }
        }
      `),
    );

    expect(data.cancelPayment.__typename).toBe('CancelPaymentError');
    expect(data.cancelPayment.errorCode).toBe('VIVA_PAYMENT_NOT_CANCELLABLE');
  });

  // -------------------------------------------------------------------------
  // #12 — cancel must transition the Vendure Payment to Cancelled, not just
  // void Viva, or a lingering Created payment keeps the order's outstanding
  // amount at 0 and blocks retry.
  //
  // This runs the REAL PaymentService.cancelPayment against the real payment
  // FSM (the path the resolver now delegates to). The handler's Viva-void leg
  // is mocked via _testInjectDeps so no network is hit; everything else — the
  // Payment entity, the FSM transition, the order — is real. The order total is
  // non-zero so the default process's onTransitionEnd does not auto-transition
  // the order on a Cancelled (uncovered) payment.
  //
  // NOTE: this mutates the handler's module-level deps, so it is the last test
  // in the file (no later test exercises the handler runtime path).
  // -------------------------------------------------------------------------
  it('#12 — cancelPayment transitions the Payment Created → Cancelled and frees the full amount', async () => {
    const TOTAL = 998;
    const paymentService = server.app.get(PaymentService);
    const orderService = server.app.get(OrderService);
    const connection = server.app.get(TransactionalConnection);
    const ctx = await server.app.get(RequestContextService).create({ apiType: 'admin' });

    // 1. Seed a real 'viva' PaymentMethod on the default channel (required by
    //    PaymentService → getMethodAndOperations).
    await adminClient.asSuperAdmin();
    await adminClient.query(
      parse(`
        mutation {
          createPaymentMethod(input: {
            code: "viva",
            enabled: true,
            translations: [{ languageCode: en, name: "Viva", description: "" }],
            handler: { code: "viva", arguments: [] }
          }) { id code }
        }
      `),
    );

    // 2. Real order with a non-zero total (totalWithTax = subTotalWithTax).
    const order = await orderService.create(ctx);
    order.subTotal = TOTAL;
    order.subTotalWithTax = TOTAL;
    await connection.getRepository(ctx, Order).save(order);

    // 3. Real Payment in 'Created' (PaymentService.create forces the initial
    //    state) linked to the order.
    const payment = await paymentService.create(ctx, {
      method: 'viva',
      amount: TOTAL,
      metadata: {},
    });
    await connection
      .getRepository(ctx, Order)
      .createQueryBuilder()
      .relation('payments')
      .of(order)
      .add(payment);

    expect(payment.state).toBe('Created');

    // Before cancel: the Created payment IS counted as covering the order
    // (this is exactly what blocked retry).
    const coveredBefore = [payment].filter(
      (p) => !['Error', 'Declined', 'Cancelled'].includes(p.state),
    );
    expect(coveredBefore).toHaveLength(1);

    // 4. Mock the handler's Viva-void leg (no network).
    _testInjectDeps({
      options: {
        mode: 'isv',
        environment: 'demo',
        legacyMerchantId: 'm',
        legacyApiKey: 'k',
        reseller: { resellerId: 'r', merchantId: 'm', resellerApiKey: 'k' },
      } as any,
      oauth2: {} as any,
      stateMachine: {
        getVivaTransaction: async () => ({
          id: 'row-12',
          status: 'pending',
          vivaOrderCode: '6652359299366382',
          metadata: { vivaMerchantId: 'merchant-uuid-12' },
        }),
        setStatus: async () => undefined,
      } as any,
      isvPayments: { cancelOrder: async () => undefined } as any,
    });

    // 5. The fix: cancel through the payment state machine.
    const result = await paymentService.cancelPayment(ctx, payment.id);

    // Payment is now Cancelled (not a transition-error result).
    expect((result as InstanceType<typeof Payment>).state).toBe('Cancelled');

    // Reload from the DB and confirm the persisted state + freed amount.
    const reloaded = await paymentService.findOneOrThrow(ctx, payment.id);
    expect(reloaded.state).toBe('Cancelled');

    const coveredAfter = [reloaded].filter(
      (p) => !['Error', 'Declined', 'Cancelled'].includes(p.state),
    );
    expect(coveredAfter).toHaveLength(0); // outstanding == full total → retry unblocked
    const outstanding = TOTAL - coveredAfter.reduce((sum, p) => sum + p.amount, 0);
    expect(outstanding).toBe(TOTAL);
  });

  // -------------------------------------------------------------------------
  // #16 — a NON-404 cancelOrder failure must still free the local Payment.
  //
  // #14 freed only the 404 (already-gone) branch; every other non-retryable
  // Viva error (4xx non-cancellable state) still threw, leaving the Payment in
  // Created → totalCoveredByPayments() keeps counting it → retry's amountToPay
  // is 0 → createPayment throws isvAmountTooHigh(_, 0), with NO Shop-API
  // recovery. This drives the REAL PaymentService.cancelPayment with the
  // handler's Viva-void leg mocked to throw a non-retryable 400 VivaApiError,
  // and asserts the Payment still reaches Cancelled (order freed for retry).
  // Mirrors #12 but exercises the error path #16 left bricked.
  // -------------------------------------------------------------------------
  it('#16 — cancelPayment still frees the Payment when Viva cancelOrder fails non-retryably (non-404)', async () => {
    const TOTAL = 777;
    const paymentService = server.app.get(PaymentService);
    const orderService = server.app.get(OrderService);
    const connection = server.app.get(TransactionalConnection);
    const ctx = await server.app.get(RequestContextService).create({ apiType: 'admin' });

    // 'viva' PaymentMethod already seeded by the #12 test on the shared server.
    const order = await orderService.create(ctx);
    order.subTotal = TOTAL;
    order.subTotalWithTax = TOTAL;
    await connection.getRepository(ctx, Order).save(order);

    const payment = await paymentService.create(ctx, { method: 'viva', amount: TOTAL, metadata: {} });
    await connection
      .getRepository(ctx, Order)
      .createQueryBuilder()
      .relation('payments')
      .of(order)
      .add(payment);
    expect(payment.state).toBe('Created');

    // Mock the Viva-void leg to throw a non-retryable 4xx (e.g. order in a
    // non-cancellable state). Pre-#16 this propagated and left the Payment stuck.
    let setStatusCalledWith: string | undefined;
    _testInjectDeps({
      options: {
        mode: 'isv',
        environment: 'demo',
        legacyMerchantId: 'm',
        legacyApiKey: 'k',
        reseller: { resellerId: 'r', merchantId: 'm', resellerApiKey: 'k' },
      } as any,
      oauth2: {} as any,
      stateMachine: {
        getVivaTransaction: async () => ({
          id: 'row-16',
          status: 'pending',
          vivaOrderCode: '6652359299366399',
          metadata: { vivaMerchantId: 'merchant-uuid-16' },
        }),
        setStatus: async (_c: unknown, _id: unknown, status: string) => {
          setStatusCalledWith = status;
        },
      } as any,
      isvPayments: {
        cancelOrder: async () => {
          throw new VivaApiError({ message: 'Order cannot be cancelled', httpStatus: 400, vivaCode: '100' });
        },
      } as any,
    });

    // Must NOT throw — the Payment is freed despite the Viva-side failure.
    const result = await paymentService.cancelPayment(ctx, payment.id);
    expect((result as InstanceType<typeof Payment>).state).toBe('Cancelled');

    const reloaded = await paymentService.findOneOrThrow(ctx, payment.id);
    expect(reloaded.state).toBe('Cancelled');
    // The row was still marked cancelled (handler reached Step 6 after swallowing).
    expect(setStatusCalledWith).toBe('cancelled');

    // Order outstanding is back to the full total → retry unblocked.
    const coveredAfter = [reloaded].filter(
      (p) => !['Error', 'Declined', 'Cancelled'].includes(p.state),
    );
    expect(coveredAfter).toHaveLength(0);
  });

  // ===========================================================================
  // #26 — FULL-STACK cancel/retry flow: Shop-API resolver → PaymentService →
  // payment-method handler → real Vendure FSM + real DB. Only the Viva HTTP
  // boundary (retrieveTransaction / cancelOrder) and the per-payment settle
  // hook are stubbed; everything else is the real booted plugin.
  //
  // WHY THIS LAYER: the 0.3.2 regression slipped through a test seam. The
  // handler-only tests called PaymentService.cancelPayment directly (skipping
  // the resolver's Step-6 pre-guard); the resolver unit test mocked
  // PaymentService.cancelPayment (skipping the handler). Neither drove
  // resolver→handler together, so the pre-guard shadowing the reconcile went
  // unseen and shipped green. These tests drive the WHOLE flow, every branch.
  // ===========================================================================

  const ISV_TEST_OPTIONS = {
    mode: 'isv',
    environment: 'demo',
    legacyMerchantId: 'm',
    legacyApiKey: 'k',
    reseller: { resellerId: 'r', merchantId: 'm', resellerApiKey: 'k' },
  } as any;

  // Build the REAL resolver from the booted app, wired to the same stubbed state
  // machine the handler uses. Auth (_isOrderOwner) is unit-tested in
  // shop-api-cancel.test.ts; here we satisfy it via the anonymous active-order
  // path (the Proxy returns our order from getActiveOrderForUser) so the test
  // focuses on the guard→handler→FSM seam. findOne / transitionToState stay real.
  function buildBootedResolver(order: InstanceType<typeof Order>, stateMachine: unknown): VivaShopApiResolver {
    const realOrderService = server.app.get(OrderService);
    const orderServiceForResolver = new Proxy(realOrderService, {
      get(target, prop) {
        if (prop === 'getActiveOrderForUser') return async () => order;
        const v = (target as any)[prop];
        return typeof v === 'function' ? v.bind(target) : v;
      },
    });
    return new VivaShopApiResolver(
      orderServiceForResolver as any,
      server.app.get(PaymentService),
      server.app.get(TransactionalConnection),
      stateMachine as any,
      ISV_TEST_OPTIONS,
    );
  }

  // Drive the whole cancel flow end-to-end for one scenario and return the
  // observable outcomes (resolver result + reloaded DB state + Viva-boundary spies).
  async function runFullCancelFlow(opts: {
    total: number;
    rowStatus: string; // viva_transaction.status seeded in the DB
    vivaStatusId?: string; // what retrieveTransaction reports ('F' = captured)
    cancelOrderThrows?: Error; // simulate a Viva-side cancelOrder failure
  }): Promise<{
    result: any;
    paymentState: string;
    rowStatusAfter: string | undefined;
    settleCalled: boolean;
    cancelOrderCalled: boolean;
  }> {
    const { total, rowStatus, vivaStatusId = 'A', cancelOrderThrows } = opts;
    const paymentService = server.app.get(PaymentService);
    const orderService = server.app.get(OrderService);
    const connection = server.app.get(TransactionalConnection);
    const realSM = server.app.get(StateMachineService);
    const ctx = await server.app.get(RequestContextService).create({ apiType: 'shop' });

    // Real order + real Created payment, linked.
    const order = await orderService.create(ctx);
    order.subTotal = total;
    order.subTotalWithTax = total;
    await connection.getRepository(ctx, Order).save(order);
    // Numeric Viva order code — the handler does BigInt(vivaOrderCode) before the
    // cancelOrder call, so a non-numeric code would throw there and never reach Viva.
    const orderCode = String(6652359299360000 + total);
    const payment = await paymentService.create(ctx, {
      method: 'viva',
      amount: total,
      metadata: { vivaOrderCode: orderCode },
    });
    await connection
      .getRepository(ctx, Order)
      .createQueryBuilder()
      .relation('payments')
      .of(order)
      .add(payment);
    expect(payment.state).toBe('Created');

    // Real viva_transaction row keyed to the real Payment.id.
    const txnRepo = connection.getRepository(ctx, VivaTransaction);
    await txnRepo.save(
      txnRepo.create({
        channelId: ctx.channelId as any,
        paymentId: payment.id as any,
        status: rowStatus as any,
        vivaOrderCode: orderCode,
        vivaTransactionId: `tx-${String(order.id)}`,
        amountMinor: String(total),
        currencyCode: 'GBP',
        isvAmountMinor: '0',
        metadata: { vivaMerchantId: 'merchant-uuid', vivaOrderCode: orderCode },
      }),
    );

    // Real state machine, but stub the per-payment settle hook — a genuine settle
    // needs a fully-arranged order; the settle MECHANISM is covered by the 1796
    // webhook tests. Real getVivaTransaction/setStatus hit the DB so the reconcile
    // and the row transition are exercised for real.
    let settleCalled = false;
    const smForTest: any = Object.create(realSM);
    smForTest.transitionPaymentToSettled = async () => {
      settleCalled = true;
    };

    let cancelOrderCalled = false;
    _testInjectDeps({
      options: ISV_TEST_OPTIONS,
      oauth2: {} as any,
      stateMachine: smForTest,
      isvPayments: {
        retrieveTransaction: async () => ({
          statusId: vivaStatusId,
          orderCode: BigInt(1),
          amount: BigInt(total),
        }),
        cancelOrder: async () => {
          cancelOrderCalled = true;
          if (cancelOrderThrows) throw cancelOrderThrows;
          return {};
        },
      } as any,
    });

    const resolver = buildBootedResolver(order, smForTest);
    const result = (await resolver.cancelPayment(String(payment.id), ctx)) as any;
    const reloadedPayment = await paymentService.findOneOrThrow(ctx, payment.id);
    const reloadedRow = await txnRepo.findOne({ where: { paymentId: payment.id as any } });
    return {
      result,
      paymentState: reloadedPayment.state,
      rowStatusAfter: reloadedRow?.status,
      settleCalled,
      cancelOrderCalled,
    };
  }

  it('#26 flow — baseline: pending row → cancel frees the Payment (Created → Cancelled)', async () => {
    const o = await runFullCancelFlow({ total: 611, rowStatus: 'pending' });
    expect(o.result.__typename).toBe('Order');
    expect(o.paymentState).toBe('Cancelled');
    expect(o.rowStatusAfter).toBe('cancelled');
    expect(o.cancelOrderCalled).toBe(true);
    expect(o.settleCalled).toBe(false);
  });

  it('#26 flow — REGRESSION: captured row + Viva NOT captured → resolver no longer shadows; Payment freed', async () => {
    // This is the exact 0.3.2 brick: Step 6 used to refuse here, the handler
    // reconcile never ran, the Created payment stranded, retry died on
    // isvAmountTooHigh(_, 0). Now the resolver falls through and the handler frees it.
    const o = await runFullCancelFlow({ total: 612, rowStatus: 'captured', vivaStatusId: 'A' });
    expect(o.result.__typename).toBe('Order');
    expect(o.paymentState).toBe('Cancelled');
    expect(o.rowStatusAfter).toBe('cancelled');
    expect(o.cancelOrderCalled).toBe(true);
    expect(o.settleCalled).toBe(false);
  });

  it('#26 flow — captured row + Viva CONFIRMS capture → settles, never voids, Payment not freed', async () => {
    const o = await runFullCancelFlow({ total: 613, rowStatus: 'captured', vivaStatusId: 'F' });
    // Money was taken: the handler settles and refuses the cancel; resolver maps
    // the refusal to an error. The captured Viva order is NEVER voided.
    expect(o.result.__typename).toBe('CancelPaymentError');
    expect(o.settleCalled).toBe(true);
    expect(o.cancelOrderCalled).toBe(false);
    expect(o.paymentState).not.toBe('Cancelled');
  });

  it('#27 flow — diverged `cancelled` row + Payment still Created → self-heals (Payment freed), NOT refused', async () => {
    // The exact 0.3.3 brick (#27): a half-applied cancel left `row=cancelled`
    // while the Vendure Payment was still `Created`. The old Step-6 guard keyed
    // off the ROW status (`cancelled` ∈ terminal) and refused forever, so every
    // retry died on isvAmountTooHigh(_, 0) with no escape. The guard now keys off
    // the authoritative Payment.state — `Created` is cancellable regardless of the
    // row — so the resolver falls through, voids Viva (idempotent), and frees the
    // Payment. End-to-end against a real Vendure instance (the @Transaction
    // interceptor is live here, so the row-cancel + Payment transition are one
    // atomic commit).
    const o = await runFullCancelFlow({ total: 614, rowStatus: 'cancelled' });
    expect(o.result.__typename).toBe('Order');
    expect(o.paymentState).toBe('Cancelled');
    expect(o.rowStatusAfter).toBe('cancelled');
    expect(o.cancelOrderCalled).toBe(true);
    expect(o.settleCalled).toBe(false);
  });

  it('#26 flow — Viva cancelOrder fails non-retryably (400) → Payment still freed (#16 invariant, end-to-end)', async () => {
    const o = await runFullCancelFlow({
      total: 615,
      rowStatus: 'pending',
      cancelOrderThrows: new VivaApiError({ message: 'Order cannot be cancelled', httpStatus: 400, vivaCode: '100' }),
    });
    expect(o.result.__typename).toBe('Order');
    expect(o.paymentState).toBe('Cancelled');
    expect(o.cancelOrderCalled).toBe(true);
  });

  // -------------------------------------------------------------------------
  // #13 — the viva_transaction row is keyed by an order.id proxy at write time
  // (Vendure assigns Payment.id only after createPayment returns). The viva
  // PaymentProcess.onTransitionStart must reconcile that proxy to the real
  // Payment.id, or every later lookup by Payment.id (cancelPayment, the webhook
  // settle path, settlePayment, createRefund) misses — and #12's cancel fix is
  // unreachable.
  //
  // This drives the REAL booted-and-init'd vivaPaymentProcess hook against the
  // real DB, with the proxy paymentId set to a sentinel distinct from the real
  // Payment.id so it proves reconciliation regardless of id collisions.
  // -------------------------------------------------------------------------
  it('#13 — onTransitionStart reconciles the viva_transaction paymentId proxy to the real Payment.id', async () => {
    const ORDER_CODE = 'RC-13-6652359299366382';
    const PROXY_PAYMENT_ID = 987654; // stands in for order.id, deliberately != real Payment.id
    const connection = server.app.get(TransactionalConnection);
    const stateMachine = server.app.get(StateMachineService);
    const paymentService = server.app.get(PaymentService);
    const ctx = await server.app.get(RequestContextService).create({ apiType: 'admin' });

    // 1. Pending row written keyed on the (proxy) order id, carrying a unique
    //    vivaOrderCode — exactly what createPayment persists.
    await connection.getRepository(ctx, VivaTransaction).save(
      connection.getRepository(ctx, VivaTransaction).create({
        channelId: ctx.channelId as any,
        paymentId: PROXY_PAYMENT_ID as any,
        status: 'pending' as any,
        vivaOrderCode: ORDER_CODE,
        vivaTransactionId: null,
        amountMinor: '998',
        currencyCode: 'GBP',
        isvAmountMinor: '0',
        metadata: { vivaOrderCode: ORDER_CODE },
      }),
    );

    // 2. A real Payment whose metadata carries the same vivaOrderCode (as
    //    createPayment returns it). Its real id differs from the proxy.
    const payment = await paymentService.create(ctx, {
      method: 'viva',
      amount: 998,
      metadata: { vivaOrderCode: ORDER_CODE },
    });
    expect(payment.id).not.toBe(PROXY_PAYMENT_ID);

    // Before reconciliation: lookup by the REAL Payment.id misses (row still
    // keyed by the proxy) — this is the bug.
    expect(await stateMachine.getVivaTransaction(ctx, ctx.channelId, payment.id)).toBeNull();

    // 3. Fire the REAL booted process hook (init already wired its StateMachineService).
    await (vivaPaymentProcess as any).onTransitionStart('Created', 'Created', {
      ctx,
      order: payment.order ?? {},
      payment,
    });

    // After: lookup by the real Payment.id resolves the row (paymentId reconciled).
    const reconciled = await stateMachine.getVivaTransaction(ctx, ctx.channelId, payment.id);
    expect(reconciled).not.toBeNull();
    expect(String(reconciled!.paymentId)).toBe(String(payment.id));
    expect(reconciled!.vivaOrderCode).toBe(ORDER_CODE);

    // Idempotent: a second hook call is a no-op (still resolves, no throw).
    await (vivaPaymentProcess as any).onTransitionStart('Created', 'Created', {
      ctx,
      order: payment.order ?? {},
      payment,
    });
    const again = await stateMachine.getVivaTransaction(ctx, ctx.channelId, payment.id);
    expect(String(again!.paymentId)).toBe(String(payment.id));
  });
});
