/**
 * test/merchant-mode/helpers.ts — Shared test fixtures for slice-B merchant
 * mode unit tests.
 *
 * Approach:
 *   - Construct VivaPaymentProvider with a valid VivaPluginConfig so the real
 *     constructor wiring is exercised (`buildPaymentsClient`, `buildLegacyClient`,
 *     `buildFastRefundClient`).
 *   - Replace the `isvPayments`, `fastRefundClient`, and `em` fields with
 *     vi.fn-backed mocks immediately after construction. This keeps the
 *     constructor under test while letting per-test assertions inspect Viva
 *     API calls without hitting the wire.
 *
 * No DB, no network. Pure unit tests.
 */

import { vi } from 'vitest';
import { VivaPaymentProvider } from '../../src/service.js';
import type { VivaPluginConfig, VivaMerchantConfig, VivaIsvConfig } from '../../src/config.js';
import type { VivaTransaction } from '../../src/models/viva-transaction.js';

// ---------------------------------------------------------------------------
// Config builders
// ---------------------------------------------------------------------------

export function merchantConfig(
  overrides: Partial<VivaMerchantConfig> = {},
): VivaMerchantConfig {
  return {
    mode: 'merchant',
    environment: 'demo',
    clientId: 'test-client-id',
    clientSecret: 'test-client-secret',
    legacyMerchantId: '11111111-1111-1111-1111-111111111111',
    legacyApiKey: 'test-api-key',
    webhookVerificationKey: 'test-webhook-key',
    refundStrategy: 'auto',
    ...overrides,
  };
}

export function isvConfig(overrides: Partial<VivaIsvConfig> = {}): VivaIsvConfig {
  return {
    mode: 'isv',
    environment: 'demo',
    clientId: 'test-client-id',
    clientSecret: 'test-client-secret',
    legacyMerchantId: '11111111-1111-1111-1111-111111111111',
    legacyApiKey: 'test-api-key',
    webhookVerificationKey: 'test-webhook-key',
    refundStrategy: 'auto',
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// In-memory repository — backs `em.getRepository('VivaTransaction')`.
// ---------------------------------------------------------------------------

export interface FakeRepo<T extends Record<string, unknown>> {
  rows: T[];
  findOne: ReturnType<typeof vi.fn>;
  create: ReturnType<typeof vi.fn>;
}

export interface FakeEm {
  rows: VivaTransaction[];
  getRepository: ReturnType<typeof vi.fn>;
  persistAndFlush: ReturnType<typeof vi.fn>;
  flush: ReturnType<typeof vi.fn>;
}

/**
 * Build a fake EntityManager whose `getRepository('VivaTransaction')` returns
 * a repo backed by an in-memory rows array. `persistAndFlush` appends rows;
 * `flush` is a no-op (mutations on rows from findOne are reflected directly).
 */
export function buildFakeEm(seedRows: VivaTransaction[] = []): FakeEm {
  const rows: VivaTransaction[] = [...seedRows];

  const repo = {
    findOne: vi.fn(async (where: Partial<VivaTransaction>) => {
      return (
        rows.find((r) =>
          Object.entries(where).every(([k, v]) => (r as Record<string, unknown>)[k] === v),
        ) ?? null
      );
    }),
    create: vi.fn((data: VivaTransaction) => data),
  };

  return {
    rows,
    getRepository: vi.fn(() => repo),
    persistAndFlush: vi.fn(async (entity: VivaTransaction) => {
      rows.push(entity);
    }),
    flush: vi.fn(async () => {
      /* no-op — mutations on findOne result are already in-memory */
    }),
  };
}

// ---------------------------------------------------------------------------
// Mock Payments + FastRefundClient
// ---------------------------------------------------------------------------

export interface MockPayments {
  createOrder: ReturnType<typeof vi.fn>;
  retrieveTransaction: ReturnType<typeof vi.fn>;
  refundPayment: ReturnType<typeof vi.fn>;
  cancelOrder: ReturnType<typeof vi.fn>;
}

export function buildMockPayments(): MockPayments {
  return {
    createOrder: vi.fn(async () => ({ orderCode: 9876543210123456n })),
    retrieveTransaction: vi.fn(async () => ({
      transactionId: 'tx-1',
      orderCode: 9876543210123456n,
      statusId: 'F',
      amount: 1000n,
      currencyCode: '978',
      merchantId: '11111111-1111-1111-1111-111111111111',
      parentId: null,
      insDate: '2026-05-12T00:00:00Z',
      transactionTypeId: 5,
      cardType: 'Visa',
      cardTypeId: 1,
    })),
    refundPayment: vi.fn(async () => ({
      transactionId: 'refund-tx-1',
      statusId: 'F',
      amount: 1000n,
    })),
    cancelOrder: vi.fn(async () => ({
      orderCode: 9876543210123456n,
      errorCode: 0,
      errorText: '',
    })),
  };
}

export interface MockFastRefundClient {
  refund: ReturnType<typeof vi.fn>;
}

export function buildMockFastRefundClient(): MockFastRefundClient {
  return {
    refund: vi.fn(async () => ({
      transactionId: 'fast-refund-tx-1',
      eventId: 0,
      amount: 1000,
    })),
  };
}

// ---------------------------------------------------------------------------
// Provider construction
// ---------------------------------------------------------------------------

export interface ProviderUnderTest {
  provider: VivaPaymentProvider;
  em: FakeEm;
  payments: MockPayments;
  fastRefund: MockFastRefundClient;
}

/**
 * Construct a `VivaPaymentProvider` with the real constructor wiring, then
 * replace network-bound fields with mocks. The constructor builds an
 * IsvHttpClient, BasicAuthClient, Payments, and FastRefundClient — none of
 * which make network calls at construction time, so this is safe.
 */
export function buildProvider(config: VivaPluginConfig, seedRows: VivaTransaction[] = []): ProviderUnderTest {
  const em = buildFakeEm(seedRows);
  const payments = buildMockPayments();
  const fastRefund = buildMockFastRefundClient();

  // The provider constructor reads `container.manager` for the EM and calls
  // `new DefaultTenantResolver(em)` — both wired through our FakeEm.
  const provider = new VivaPaymentProvider(
    { manager: em as unknown as object },
    { config },
  );

  // Field overrides — bypass TS protected modifier for tests.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (provider as any).em = em;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (provider as any).isvPayments = payments;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (provider as any).fastRefundClient = fastRefund;

  return { provider, em, payments, fastRefund };
}

// ---------------------------------------------------------------------------
// Row builders
// ---------------------------------------------------------------------------

export function buildCapturedRow(overrides: Partial<VivaTransaction> = {}): VivaTransaction {
  const now = new Date();
  return {
    viva_transaction_id: '22222222-2222-2222-2222-222222222222',
    viva_order_code: '9876543210123456',
    medusa_payment_id: 'pay_test_001',
    viva_merchant_id: '11111111-1111-1111-1111-111111111111',
    status: 'captured',
    claim_substate: null,
    amount_minor: '2000',
    refunded_amount_minor: '0',
    currency_code: '978',
    idempotency_key: 'pay_test_001',
    raw_payload: { TransactionId: 'viva-tx-uuid-1' },
    created_at: now,
    updated_at: now,
    ...overrides,
  };
}
