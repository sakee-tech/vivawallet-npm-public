/**
 * test/api/admin-sources.test.ts — Phase 3 slice C admin REST tests.
 *
 * Covers POST /viva/admin/connected-accounts/:id/sources:
 *   1. Merchant mode → 404 (mode-gate).
 *   2. ISV mode without `options.reseller` → 412 VIVA_RESELLER_CREDENTIALS_MISSING.
 *   3. Account not verified → 409 VIVA_ACCOUNT_NOT_VERIFIED.
 *   4. Verified account, kind='ecommerce' → 201 + createEcommerceSource called.
 *   5. Verified account, kind='physical' → 201 + createPhysicalSource called.
 *   6. Invalid kind → 400.
 *   7. Viva 4xx on /api/sources → 422 VIVA_SOURCE_CREATION_FAILED.
 *   8. Reseller Basic auth header is built with `account.merchantId` in the
 *      username slot (NOT options.reseller.merchantId) per AUTH.md §1.2.
 *
 * Controller is invoked directly (no Nest server) — mirrors the pattern of
 * test/api/admin-onboarding.test.ts.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { ServerResponse } from 'node:http';
import { AdminSourcesController } from '../../src/api/admin-sources.controller.js';
import type { VivaPaymentPluginOptions } from '../../src/types.js';
import { VivaApiError } from '@sakeetech/viva-payments-core/errors';

// ---------------------------------------------------------------------------
// Mock IsvSources + BasicAuthClient at the core level so we can assert that
// Reseller Basic auth is constructed with account.merchantId.
// ---------------------------------------------------------------------------

const createEcommerceSourceMock = vi.fn();
const createPhysicalSourceMock = vi.fn();
const basicAuthClientCtorMock = vi.fn();

vi.mock('@sakeetech/viva-payments-core/legacy', () => {
  class BasicAuthClient {
    constructor(config: unknown) {
      basicAuthClientCtorMock(config);
    }
  }
  return { BasicAuthClient };
});

vi.mock('@sakeetech/viva-payments-core/isv', () => {
  class IsvHttpClient {}
  class IsvAccounts {
    retrieveConnectedAccount = vi.fn();
  }
  class IsvSources {
    createEcommerceSource = createEcommerceSourceMock;
    createPhysicalSource = createPhysicalSourceMock;
  }
  return { IsvHttpClient, IsvAccounts, IsvSources };
});

// ---------------------------------------------------------------------------
// Response mock (matches admin-onboarding.test.ts)
// ---------------------------------------------------------------------------

function makeMockResponse(): ServerResponse & {
  _status: number;
  _body: string;
} {
  return {
    _status: 200,
    _body: '',
    writeHead(s: number) {
      (this as any)._status = s;
    },
    end(data?: string) {
      (this as any)._body = data ?? '';
    },
  } as unknown as ServerResponse & { _status: number; _body: string };
}

// ---------------------------------------------------------------------------
// Plugin-options factories
// ---------------------------------------------------------------------------

function makeIsvOptions(opts: { reseller?: boolean } = {}): VivaPaymentPluginOptions {
  const reseller =
    opts.reseller === false
      ? undefined
      : {
          resellerId: 'reseller-uuid-platform',
          merchantId: 'platform-merchant-uuid',
          resellerApiKey: 'reseller-secret',
        };
  const base: any = {
    mode: 'isv',
    clientId: 'test-id',
    clientSecret: 'test-secret',
    environment: 'demo',
    webhookVerificationKey: 'verify-key',
    legacyMerchantId: 'legacy-merchant',
    legacyApiKey: 'legacy-key',
    successUrl: 'https://example.com/success',
    failureUrl: 'https://example.com/failure',
    onboardingReturnUrl: 'https://example.com/return',
  };
  if (reseller) base.reseller = reseller;
  return base as VivaPaymentPluginOptions;
}

function makeMerchantOptions(): VivaPaymentPluginOptions {
  return {
    mode: 'merchant',
    clientId: 'test-id',
    clientSecret: 'test-secret',
    environment: 'demo',
    webhookVerificationKey: 'verify-key',
    legacyMerchantId: 'legacy-merchant',
    legacyApiKey: 'legacy-key',
    successUrl: 'https://example.com/success',
    failureUrl: 'https://example.com/failure',
  };
}

// ---------------------------------------------------------------------------
// Controller harness — overrides buildIsvAccounts (private) similar to
// admin-onboarding.test.ts.
// ---------------------------------------------------------------------------

function makeRetrieve(opts: { verified: boolean; merchantId: string | null }) {
  return vi.fn().mockResolvedValue({
    accountId: 'acc_test_001',
    merchantId: opts.merchantId,
    verified: opts.verified,
    acquiringEnabled: opts.verified,
    email: 'm@example.com',
  });
}

function buildController(
  options: VivaPaymentPluginOptions,
  retrieve: ReturnType<typeof makeRetrieve> = makeRetrieve({
    verified: true,
    merchantId: 'merch-uuid-001',
  }),
) {
  const oauth2 = { getBearerToken: vi.fn().mockResolvedValue('test-token') };
  const ctrl = new AdminSourcesController(options, oauth2 as any);
  // Monkey-patch buildIsvAccounts to return a stub.
  (ctrl as any).buildIsvAccounts = () => ({ retrieveConnectedAccount: retrieve });
  return { ctrl, retrieve };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('AdminSourcesController — POST /viva/admin/connected-accounts/:id/sources', () => {
  beforeEach(() => {
    vi.spyOn(console, 'warn').mockReturnValue(undefined);
    vi.spyOn(console, 'info').mockReturnValue(undefined);
    vi.spyOn(console, 'error').mockReturnValue(undefined);
    createEcommerceSourceMock.mockReset();
    createPhysicalSourceMock.mockReset();
    basicAuthClientCtorMock.mockReset();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('1. merchant mode → 404', async () => {
    const { ctrl } = buildController(makeMerchantOptions());
    const res = makeMockResponse();
    await ctrl.createSource(
      'acc_test_001',
      { kind: 'ecommerce', domain: 'example.com', pathSuccess: '/ok', pathFail: '/no' },
      res,
    );
    expect(res._status).toBe(404);
    const body = JSON.parse(res._body);
    expect(body.code).toBe('VIVA_CHANNEL_MISCONFIGURED');
    expect(body.message).toContain('ISV-only');
    expect(createEcommerceSourceMock).not.toHaveBeenCalled();
  });

  it('2. ISV mode without reseller → 412 VIVA_RESELLER_CREDENTIALS_MISSING', async () => {
    const { ctrl } = buildController(makeIsvOptions({ reseller: false }));
    const res = makeMockResponse();
    await ctrl.createSource(
      'acc_test_001',
      { kind: 'ecommerce', domain: 'example.com', pathSuccess: '/ok', pathFail: '/no' },
      res,
    );
    expect(res._status).toBe(412);
    const body = JSON.parse(res._body);
    expect(body.code).toBe('VIVA_RESELLER_CREDENTIALS_MISSING');
  });

  it('3. ISV account not verified → 409 VIVA_ACCOUNT_NOT_VERIFIED', async () => {
    const { ctrl } = buildController(
      makeIsvOptions(),
      makeRetrieve({ verified: false, merchantId: null }),
    );
    const res = makeMockResponse();
    await ctrl.createSource(
      'acc_test_001',
      { kind: 'ecommerce', domain: 'example.com', pathSuccess: '/ok', pathFail: '/no' },
      res,
    );
    expect(res._status).toBe(409);
    const body = JSON.parse(res._body);
    expect(body.code).toBe('VIVA_ACCOUNT_NOT_VERIFIED');
    expect(createEcommerceSourceMock).not.toHaveBeenCalled();
  });

  it('4. ecommerce 201 + createEcommerceSource called with body input', async () => {
    createEcommerceSourceMock.mockResolvedValueOnce({
      sourceCode: 1234,
      name: 'My Web Source',
    });
    const { ctrl } = buildController(makeIsvOptions());
    const res = makeMockResponse();
    await ctrl.createSource(
      'acc_test_001',
      {
        kind: 'ecommerce',
        domain: 'shop.example.com',
        pathSuccess: '/success',
        pathFail: '/fail',
        isSecure: true,
        name: 'My Web Source',
      },
      res,
    );
    expect(res._status).toBe(201);
    const body = JSON.parse(res._body);
    expect(body.sourceCode).toBe(1234);
    expect(body.kind).toBe('ecommerce');
    expect(body.name).toBe('My Web Source');
    expect(createEcommerceSourceMock).toHaveBeenCalledTimes(1);
    const arg = createEcommerceSourceMock.mock.calls[0]![0];
    expect(arg.domain).toBe('shop.example.com');
    expect(arg.pathSuccess).toBe('/success');
    expect(arg.pathFail).toBe('/fail');
    expect(arg.isSecure).toBe(true);
  });

  it('5. physical 201 + createPhysicalSource called with body input', async () => {
    createPhysicalSourceMock.mockResolvedValueOnce({
      sourceCode: 5678,
      name: 'Counter 1',
    });
    const { ctrl } = buildController(makeIsvOptions());
    const res = makeMockResponse();
    await ctrl.createSource(
      'acc_test_001',
      { kind: 'physical', name: 'Counter 1' },
      res,
    );
    expect(res._status).toBe(201);
    const body = JSON.parse(res._body);
    expect(body.sourceCode).toBe(5678);
    expect(body.kind).toBe('physical');
    expect(createPhysicalSourceMock).toHaveBeenCalledTimes(1);
    expect(createPhysicalSourceMock.mock.calls[0]![0].name).toBe('Counter 1');
  });

  it('6. invalid kind → 400', async () => {
    const { ctrl } = buildController(makeIsvOptions());
    const res = makeMockResponse();
    await ctrl.createSource(
      'acc_test_001',
      { kind: 'pos' as any, name: 'whatever' },
      res,
    );
    expect(res._status).toBe(400);
    const body = JSON.parse(res._body);
    expect(body.code).toBe('VIVA_CHANNEL_MISCONFIGURED');
    expect(body.message).toContain('kind');
  });

  it('7. Viva 4xx on /api/sources → 422 VIVA_SOURCE_CREATION_FAILED', async () => {
    const err = new VivaApiError({
      message: 'invalid domain',
      httpStatus: 400,
      vivaCode: '1001',
    });
    createEcommerceSourceMock.mockRejectedValueOnce(err);

    const { ctrl } = buildController(makeIsvOptions());
    const res = makeMockResponse();
    await ctrl.createSource(
      'acc_test_001',
      {
        kind: 'ecommerce',
        domain: 'shop.example.com',
        pathSuccess: '/success',
        pathFail: '/fail',
      },
      res,
    );
    expect(res._status).toBe(422);
    const body = JSON.parse(res._body);
    expect(body.code).toBe('VIVA_SOURCE_CREATION_FAILED');
    expect(body.vivaErrorCode).toBe(1001);
  });

  it('8. Reseller Basic auth is built with account.merchantId (not options.reseller.merchantId)', async () => {
    createEcommerceSourceMock.mockResolvedValueOnce({ sourceCode: 1234 });
    const { ctrl } = buildController(
      makeIsvOptions(),
      makeRetrieve({ verified: true, merchantId: 'connected-merch-uuid-XYZ' }),
    );
    const res = makeMockResponse();
    await ctrl.createSource(
      'acc_test_001',
      {
        kind: 'ecommerce',
        domain: 'shop.example.com',
        pathSuccess: '/success',
        pathFail: '/fail',
      },
      res,
    );
    expect(res._status).toBe(201);
    expect(basicAuthClientCtorMock).toHaveBeenCalledTimes(1);
    const cfg = basicAuthClientCtorMock.mock.calls[0]![0];
    expect(cfg.authVariant).toBe('reseller');
    expect(cfg.resellerId).toBe('reseller-uuid-platform');
    // Critical: the merchantId slot carries the CONNECTED merchant's UUID,
    // not options.reseller.merchantId (which is 'platform-merchant-uuid').
    expect(cfg.merchantId).toBe('connected-merch-uuid-XYZ');
    expect(cfg.merchantId).not.toBe('platform-merchant-uuid');
    expect(cfg.resellerApiKey).toBe('reseller-secret');
  });
});
