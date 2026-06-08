/**
 * test/payment-method-handler/helpers.ts
 *
 * Shared test helpers for payment-method-handler tests.
 * Wires up: IsvPayments with MockAgent, mock StateMachineService,
 * mock options, and a fake RequestContext.
 */

import { MockAgent } from 'undici';
import type { Dispatcher } from 'undici';
import { IsvHttpClient, IsvPayments } from '@sakeetech/viva-payments-core/isv';
import {
  OAuth2ClientCredentialsStrategy,
  InMemoryTokenCache,
  AsyncMutex,
} from '@sakeetech/viva-payments-core/auth';
import type { VivaPaymentPluginOptions } from '../../src/types.js';
import type { VivaTransaction } from '../../src/entities/viva-transaction.entity.js';

// ---------------------------------------------------------------------------
// Demo API base URL
// ---------------------------------------------------------------------------

export const DEMO_AUTH_HOST = 'https://demo-accounts.vivapayments.com';
export const DEMO_API_HOST = 'https://demo-api.vivapayments.com';
export const PROD_API_HOST = 'https://www.vivapayments.com';

// ---------------------------------------------------------------------------
// Default plugin options
// ---------------------------------------------------------------------------

export function makeOptions(overrides: Partial<VivaPaymentPluginOptions> = {}): VivaPaymentPluginOptions {
  return {
    mode: 'isv',
    clientId: 'test-id',
    clientSecret: 'test-secret',
    environment: 'demo',
    webhookVerificationKey: 'verify-key',
    // Required for refundPayment (probe-verified 2026-04-25 F1):
    // Viva returns 405 on POST /checkout/v2/transactions/{id} (v2/OAuth2).
    // Legacy host + Basic auth (legacyMerchantId:legacyApiKey) is required.
    legacyMerchantId: 'test-legacy-merchant-uuid',
    legacyApiKey: 'test-legacy-api-key',
    successUrl: 'https://example.com/success?ref={orderCode}',
    failureUrl: 'https://example.com/failure?ref={orderCode}',
    onboardingReturnUrl: 'https://example.com/admin/viva/return',
    ...overrides,
  } as VivaPaymentPluginOptions;
}

// ---------------------------------------------------------------------------
// Fake RequestContext
// ---------------------------------------------------------------------------

export function makeCtx(overrides: {
  channelId?: string | number;
  vivaMerchantId?: string | null | false;  // false = field missing entirely
  vivaPayoutsEnabled?: boolean;
  vivaSourceCode?: string;
} = {}): any {
  // vivaMerchantId: use undefined (field absent) when caller passes null/false,
  // use the string value when provided, else default.
  const vivaMerchantId = overrides.vivaMerchantId === false || overrides.vivaMerchantId === null
    ? undefined
    : (overrides.vivaMerchantId !== undefined ? overrides.vivaMerchantId : 'merchant-uuid-1234');

  return {
    channelId: overrides.channelId ?? 1,
    channel: {
      id: overrides.channelId ?? 1,
      code: 'default',
      customFields: {
        vivaMerchantId,
        vivaPayoutsEnabled: overrides.vivaPayoutsEnabled ?? true,
        vivaSourceCode: overrides.vivaSourceCode ?? 'Default',
      },
    },
    apiType: 'shop',
  };
}

// ---------------------------------------------------------------------------
// Fake Order
// ---------------------------------------------------------------------------

export function makeOrder(overrides: Partial<{
  id: string | number;
  code: string;
  totalWithTax: number;
  currencyCode: string;
  state: string;
}> = {}): any {
  return {
    id: overrides.id ?? 42,
    code: overrides.code ?? 'ORDER-001',
    totalWithTax: overrides.totalWithTax ?? 2000,
    currencyCode: overrides.currencyCode ?? 'GBP',
    state: overrides.state ?? 'ArrangingPayment',
  };
}

// ---------------------------------------------------------------------------
// Fake Payment
// ---------------------------------------------------------------------------

export function makePayment(overrides: Partial<{
  id: string | number;
  amount: number;
  state: string;
  metadata: Record<string, unknown>;
}> = {}): any {
  return {
    id: overrides.id ?? 99,
    amount: overrides.amount ?? 2000,
    state: overrides.state ?? 'Created',
    metadata: overrides.metadata ?? {},
  };
}

// ---------------------------------------------------------------------------
// OAuth2 strategy wired to MockAgent
// ---------------------------------------------------------------------------

export function buildOAuth2Strategy(agent: MockAgent) {
  const cache = new InMemoryTokenCache();
  const mutex = new AsyncMutex();

  // Pre-warm the cache so createPayment doesn't need a token request
  // (reduces noise — tested separately in bootstrap tests).
  const mockFetch = (url: RequestInfo | URL, init?: RequestInit) =>
    fetch(url, { ...init, dispatcher: agent as unknown as Dispatcher } as any);

  return new OAuth2ClientCredentialsStrategy({
    environment: 'demo',
    clientId: 'test-id',
    clientSecret: 'test-secret',
    cache,
    mutex,
    fetchImpl: mockFetch,
    dispatcher: agent as unknown as Dispatcher,
  });
}

/**
 * Seed a valid token into the cache so tests don't need to mock the auth endpoint.
 */
export async function seedToken(strategy: OAuth2ClientCredentialsStrategy): Promise<void> {
  const cache = (strategy as any)._cache as InMemoryTokenCache;
  await cache.set('viva:isv:token:test-id:demo', {
    access_token: 'tok_test',
    expires_in: 3600,
    token_type: 'Bearer',
    scope: '',
    expires_at: Date.now() + 3_600_000,
  });
}

// ---------------------------------------------------------------------------
// Build IsvPayments from MockAgent
// ---------------------------------------------------------------------------

export function buildIsvPayments(agent: MockAgent, strategy: OAuth2ClientCredentialsStrategy): IsvPayments {
  const client = new IsvHttpClient({
    environment: 'demo',
    authStrategy: strategy,
    dispatcher: agent as unknown as Dispatcher,
    fetchImpl: (url, init) => fetch(url, { ...init, dispatcher: agent as unknown as Dispatcher } as any) as any,
    // Disable retry backoff so tests are fast
    retryBackoffsMs: [0, 0, 0],
    jitterRatio: 0,
  });
  return new IsvPayments(client);
}

// ---------------------------------------------------------------------------
// Mock StateMachineService
// ---------------------------------------------------------------------------

export interface MockStateMachineService {
  rows: Map<string, Partial<VivaTransaction> & { id: string }>;
  getVivaTransaction: (ctx: any, channelId: any, paymentId: any) => Promise<VivaTransaction | null>;
  upsertPendingTransaction: (ctx: any, input: any) => Promise<{ row: VivaTransaction; wasInserted: boolean }>;
  setOrderCode: (ctx: any, rowId: any, vivaOrderCode: string, metadata: Record<string, unknown>) => Promise<void>;
  setStatus: (ctx: any, rowId: any, status: string, metadata?: Record<string, unknown>) => Promise<void>;
}

export function makeMockStateMachine(): MockStateMachineService {
  const rows = new Map<string, Partial<VivaTransaction> & { id: string }>();
  let nextId = 1;

  return {
    rows,
    async getVivaTransaction(_ctx, channelId, paymentId) {
      const key = `${channelId}:${paymentId}`;
      return (rows.get(key) as VivaTransaction | undefined) ?? null;
    },
    async upsertPendingTransaction(_ctx, input) {
      const key = `${input.channelId}:${input.paymentId}`;
      const existing = rows.get(key);
      if (existing) {
        return { row: existing as VivaTransaction, wasInserted: false };
      }
      const id = `row-${nextId++}`;
      const row = {
        id,
        channelId: input.channelId,
        paymentId: input.paymentId,
        idempotencyKey: input.idempotencyKey,
        amountMinor: input.amountMinor.toString(),
        currencyCode: input.currencyCode,
        isvAmountMinor: input.isvAmountMinor.toString(),
        status: 'pending' as any,
        vivaOrderCode: null,
        vivaTransactionId: null,
        metadata: { idempotencyKey: input.idempotencyKey } as Record<string, unknown>,
        createdAt: new Date(),
        updatedAt: new Date(),
      };
      rows.set(key, row);
      return { row: row as unknown as VivaTransaction, wasInserted: true };
    },
    async setOrderCode(_ctx, rowId, vivaOrderCode, metadata) {
      for (const [k, v] of rows.entries()) {
        if (v.id === rowId) {
          rows.set(k, { ...v, vivaOrderCode, metadata });
          return;
        }
      }
    },
    async setStatus(_ctx, rowId, status, metadata) {
      for (const [k, v] of rows.entries()) {
        if (v.id === rowId) {
          rows.set(k, { ...v, status: status as any, ...(metadata !== undefined ? { metadata } : {}) });
          return;
        }
      }
    },
  };
}
