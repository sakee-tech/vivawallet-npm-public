/**
 * test/merchant-mode/helpers.ts
 *
 * Shared test helpers for merchant-mode payment-method-handler tests.
 * Mirrors test/payment-method-handler/helpers.ts but constructs a
 * mode='merchant' `Payments` instance and exposes a FastRefundClient
 * override hook for the auto/fast/standard branch coverage.
 */

import { MockAgent } from 'undici';
import type { Dispatcher } from 'undici';
import { IsvHttpClient } from '@sakeetech/viva-payments-core/isv';
import { Payments } from '@sakeetech/viva-payments-core/payments';
import { BasicAuthClient } from '@sakeetech/viva-payments-core/legacy';
import { FastRefundClient } from '@sakeetech/viva-payments-core/refunds';
import {
  OAuth2ClientCredentialsStrategy,
  InMemoryTokenCache,
  AsyncMutex,
} from '@sakeetech/viva-payments-core/auth';
import type { VivaPaymentPluginOptions, VivaMerchantOptions } from '../../src/types.js';
import type { VivaTransaction } from '../../src/entities/viva-transaction.entity.js';

// ---------------------------------------------------------------------------
// Hosts
// ---------------------------------------------------------------------------

export const DEMO_API_HOST = 'https://demo-api.vivapayments.com';
export const DEMO_LEGACY_HOST = 'https://demo.vivapayments.com';

// ---------------------------------------------------------------------------
// Plugin options — merchant mode
// ---------------------------------------------------------------------------

export function makeMerchantOptions(
  overrides: Partial<VivaMerchantOptions> = {},
): VivaMerchantOptions {
  return {
    mode: 'merchant',
    clientId: 'test-id',
    clientSecret: 'test-secret',
    environment: 'demo',
    webhookVerificationKey: 'verify-key',
    legacyMerchantId: 'test-legacy-merchant-uuid',
    legacyApiKey: 'test-legacy-api-key',
    successUrl: 'https://example.com/success?ref={orderCode}',
    failureUrl: 'https://example.com/failure?ref={orderCode}',
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Fake RequestContext — merchant mode has no per-channel vivaMerchantId.
// `vivaSourceCode` is still readable per channel (operator override).
// ---------------------------------------------------------------------------

export function makeCtx(
  overrides: {
    channelId?: string | number;
    vivaSourceCode?: string;
  } = {},
): any {
  return {
    channelId: overrides.channelId ?? 1,
    channel: {
      id: overrides.channelId ?? 1,
      code: 'default',
      customFields: {
        // Merchant-mode plugin MUST NOT read these — kept here only to assert
        // that the handler ignores them.
        vivaMerchantId: 'should-be-ignored-in-merchant-mode',
        vivaPayoutsEnabled: false,
        ...(overrides.vivaSourceCode !== undefined ? { vivaSourceCode: overrides.vivaSourceCode } : {}),
      },
    },
    apiType: 'shop',
  };
}

// ---------------------------------------------------------------------------
// Fakes
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
    currencyCode: overrides.currencyCode ?? 'EUR',
    state: overrides.state ?? 'ArrangingPayment',
  };
}

// ---------------------------------------------------------------------------
// OAuth2 strategy wired to MockAgent (pre-warmed token)
// ---------------------------------------------------------------------------

export function buildOAuth2Strategy(agent: MockAgent): OAuth2ClientCredentialsStrategy {
  const cache = new InMemoryTokenCache();
  const mutex = new AsyncMutex();
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
// Build a mode='merchant' Payments instance from MockAgent + strategy.
// ---------------------------------------------------------------------------

export function buildMerchantPayments(
  agent: MockAgent,
  strategy: OAuth2ClientCredentialsStrategy,
  options: VivaPaymentPluginOptions,
): { isvPayments: Payments; legacyClient: BasicAuthClient; httpClient: IsvHttpClient } {
  const httpClient = new IsvHttpClient({
    environment: 'demo',
    authStrategy: strategy,
    dispatcher: agent as unknown as Dispatcher,
    fetchImpl: (url, init) => fetch(url, { ...init, dispatcher: agent as unknown as Dispatcher } as any) as any,
    retryBackoffsMs: [0, 0, 0],
    jitterRatio: 0,
  });
  const legacyClient = new BasicAuthClient({
    environment: 'demo',
    merchantId: options.legacyMerchantId,
    apiKey: options.legacyApiKey,
    dispatcher: agent as unknown as Dispatcher,
    fetchImpl: (url, init) => fetch(url, { ...init, dispatcher: agent as unknown as Dispatcher } as any) as any,
    retryBackoffsMs: [0, 0, 0],
    jitterRatio: 0,
  });
  const isvPayments = new Payments({
    mode: 'merchant',
    client: httpClient,
    legacyClient,
  });
  return { isvPayments, legacyClient, httpClient };
}

export function buildFastRefundClient(httpClient: IsvHttpClient): FastRefundClient {
  return new FastRefundClient({ client: httpClient });
}

// ---------------------------------------------------------------------------
// Mock StateMachineService — identical shape to ISV helpers.
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
