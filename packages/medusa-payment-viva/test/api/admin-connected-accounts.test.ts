/**
 * admin-connected-accounts.test.ts — Phase 2 slice C admin REST gating tests.
 *
 * Verifies mode-conditional admin REST surface:
 *   1. Merchant mode: POST /viva/admin/connected-accounts → 404.
 *   2. Merchant mode: GET /viva/admin/connected-accounts/:id → 404.
 *   3. ISV mode: POST /viva/admin/connected-accounts → 200 + { accountId, onboardingUrl }.
 *
 * Tests invoke the route handlers directly (no Medusa server required), so the
 * mode gate is exercised at the handler level. The ISV happy-path test spies
 * on `IsvAccounts.prototype.createConnectedAccount` to avoid a real network
 * call into Viva.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { MedusaRequest, MedusaResponse } from '@medusajs/framework/http';
import { IsvAccounts } from '@sakeetech/viva-payments-core/isv';
import type { VivaPluginConfig } from '../../src/config.js';
import { VIVA_PLUGIN_CONFIG_KEY } from '../../src/container.js';

// ---------------------------------------------------------------------------
// Helpers: mock req/res
// ---------------------------------------------------------------------------

function makeRes(): {
  res: MedusaResponse;
  status: ReturnType<typeof vi.fn>;
  json: ReturnType<typeof vi.fn>;
  lastJsonBody: () => Record<string, unknown>;
  lastStatusCode: () => number;
} {
  let _lastCode = 0;
  let _lastBody: Record<string, unknown> = {};

  const jsonFn = vi.fn((body: unknown) => {
    _lastBody = body as Record<string, unknown>;
  });
  const statusFn = vi.fn((code: number) => {
    _lastCode = code;
    return { json: jsonFn, end: vi.fn(), send: vi.fn() };
  });
  const setHeaderFn = vi.fn();

  const res = { status: statusFn, json: jsonFn, setHeader: setHeaderFn } as unknown as MedusaResponse;
  return {
    res,
    status: statusFn,
    json: jsonFn,
    lastJsonBody: () => _lastBody,
    lastStatusCode: () => _lastCode,
  };
}

function makeReq(opts: {
  headers?: Record<string, string>;
  body?: unknown;
  params?: Record<string, string>;
  config?: VivaPluginConfig;
} = {}): MedusaRequest {
  return {
    headers: opts.headers ?? {},
    body: opts.body ?? {},
    params: opts.params ?? {},
    scope: {
      resolve: (k: string, _o?: unknown) =>
        k === VIVA_PLUGIN_CONFIG_KEY ? opts.config : undefined,
    },
  } as unknown as MedusaRequest;
}

function makeConfig(mode: 'merchant' | 'isv'): VivaPluginConfig {
  const common = {
    environment: 'demo' as const,
    clientId: 'test-client',
    clientSecret: 'test-secret',
    webhookVerificationKey: 'test-wvk',
    legacyMerchantId: 'test-legacy-merchant',
    legacyApiKey: 'test-legacy-key',
    adminToken: 'admin-test-token',
  };
  if (mode === 'merchant') return { ...common, mode: 'merchant' };
  return { ...common, mode: 'isv' };
}


// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('admin connected-accounts REST — mode gating', () => {
  beforeEach(() => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('1. merchant mode: POST /viva/admin/connected-accounts → 404', async () => {
    const { POST } = await import('../../src/api/viva/admin/connected-accounts/route.js');

    const { res, status, lastJsonBody } = makeRes();
    await POST(
      makeReq({
        headers: { 'x-viva-admin-token': 'admin-test-token' },
        body: { email: 'a@b.com', returnUrl: 'https://x.com/done' },
        config: makeConfig('merchant'),
      }),
      res,
    );

    expect(status).toHaveBeenCalledWith(404);
    expect(lastJsonBody()).toEqual({ error: 'Not Found' });
  });

  it('2. merchant mode: GET /viva/admin/connected-accounts/:id → 404', async () => {
    const { GET } = await import('../../src/api/viva/admin/connected-accounts/[id]/route.js');

    const { res, status, lastJsonBody } = makeRes();
    await GET(
      makeReq({
        headers: { 'x-viva-admin-token': 'admin-test-token' },
        params: { id: 'some-account-id' },
        config: makeConfig('merchant'),
      }) as MedusaRequest<unknown, { id: string }>,
      res,
    );

    expect(status).toHaveBeenCalledWith(404);
    expect(lastJsonBody()).toEqual({ error: 'Not Found' });
  });

  it('3. ISV mode: POST /viva/admin/connected-accounts → 200 + { accountId, onboardingUrl }', async () => {
    // Spy on the prototype so we don't make a real HTTP call to Viva.
    const createSpy = vi
      .spyOn(IsvAccounts.prototype, 'createConnectedAccount')
      .mockImplementation(async () => ({
        accountId: 'acc_test_001' as never,
        invitation: {
          email: 'a@b.com',
          redirectUrl: 'https://www.vivapayments.com/onboarding/start?token=xyz',
          created: new Date().toISOString(),
        },
      }));

    const { POST } = await import('../../src/api/viva/admin/connected-accounts/route.js');

    const { res, status, lastJsonBody } = makeRes();
    await POST(
      makeReq({
        headers: { 'x-viva-admin-token': 'admin-test-token' },
        body: { email: 'a@b.com', returnUrl: 'https://x.com/done' },
        config: makeConfig('isv'),
      }),
      res,
    );

    expect(createSpy).toHaveBeenCalledTimes(1);
    expect(status).toHaveBeenCalledWith(200);
    expect(lastJsonBody()).toEqual({
      accountId: 'acc_test_001',
      onboardingUrl: 'https://www.vivapayments.com/onboarding/start?token=xyz',
    });
  });

  it('regression: merchant mode + reconcile route → 404 (no Viva fetch attempted)', async () => {
    // If the gate fails, this spy would be invoked.
    const retrieveSpy = vi.spyOn(IsvAccounts.prototype, 'retrieveConnectedAccount');

    const { POST } = await import(
      '../../src/api/viva/admin/connected-accounts/[id]/reconcile/route.js'
    );

    const { res, status } = makeRes();
    await POST(
      makeReq({
        headers: { 'x-viva-admin-token': 'admin-test-token' },
        params: { id: 'acc_xyz' },
        config: makeConfig('merchant'),
      }) as MedusaRequest<unknown, { id: string }>,
      res,
    );

    expect(status).toHaveBeenCalledWith(404);
    expect(retrieveSpy).not.toHaveBeenCalled();
  });
});
