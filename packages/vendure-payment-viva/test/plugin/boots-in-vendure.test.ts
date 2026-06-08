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
      options: { mode: 'isv', environment: 'demo', legacyMerchantId: 'm', legacyApiKey: 'k' } as any,
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
});
