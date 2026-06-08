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
import { DefaultLogger, LogLevel, LanguageCode, mergeConfig } from '@vendure/core';
import { checkPgReachable } from '../helpers/db.js';
import { VivaPaymentPlugin } from '../../src/plugin.js';

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
});
