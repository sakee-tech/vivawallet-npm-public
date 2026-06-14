/**
 * admin-sources.test.ts — Phase 2 slice F admin REST tests.
 *
 * Covers POST /viva/admin/connected-accounts/:id/sources:
 *   1. Merchant mode → 404 (mode-gate).
 *   2. ISV mode without `config.reseller` → 412 with VIVA_RESELLER_CREDENTIALS_MISSING.
 *   3. ISV mode, missing admin token → 401.
 *   4. ISV mode, account not verified → 409 with VIVA_ACCOUNT_NOT_VERIFIED.
 *   5. ISV mode, verified account, kind='ecommerce' → calls
 *      `IsvSources.createEcommerceSource` and returns 201.
 *   6. ISV mode, verified account, kind='physical' → calls
 *      `IsvSources.createPhysicalSource` and returns 201.
 *   7. ISV mode, invalid `kind` → 400.
 *   8. ISV mode, Viva returns 4xx on POST /api/sources → 422 with
 *      VIVA_SOURCE_CREATION_FAILED envelope.
 *
 * Handler is invoked directly (no Medusa server) so the mode gate is
 * exercised at the handler level.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { MedusaRequest, MedusaResponse } from '@medusajs/framework/http';
import { IsvAccounts, IsvSources } from '@sakeetech/viva-payments-core/isv';
import { VivaApiError } from '@sakeetech/viva-payments-core/errors';
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

  const res = {
    status: statusFn,
    json: jsonFn,
    setHeader: setHeaderFn,
  } as unknown as MedusaResponse;
  return {
    res,
    status: statusFn,
    json: jsonFn,
    lastJsonBody: () => _lastBody,
    lastStatusCode: () => _lastCode,
  };
}

function makeReq(
  opts: {
    headers?: Record<string, string>;
    body?: unknown;
    params?: Record<string, string>;
    config?: VivaPluginConfig;
  } = {},
): MedusaRequest<unknown, { id: string }> {
  return {
    headers: opts.headers ?? {},
    body: opts.body ?? {},
    params: opts.params ?? { id: 'acc_test_001' },
    scope: {
      resolve: (k: string, _o?: unknown) =>
        k === VIVA_PLUGIN_CONFIG_KEY ? opts.config : undefined,
    },
  } as unknown as MedusaRequest<unknown, { id: string }>;
}

function makeConfig(
  mode: 'merchant' | 'isv',
  opts: { reseller?: boolean } = {},
): VivaPluginConfig {
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
  const wantReseller = opts.reseller !== false;
  return {
    ...common,
    mode: 'isv',
    ...(wantReseller
      ? {
          reseller: {
            resellerId: 'reseller-uuid-platform',
            merchantId: 'platform-merchant-uuid',
            resellerApiKey: 'reseller-secret',
          },
        }
      : {}),
  };
}


function fakeAccount(opts: { verified: boolean; merchantId: string | null }): {
  accountId: string;
  merchantId: string | null;
  email: string | null;
  verified: boolean;
  acquiringEnabled: boolean;
  created: string | null;
  taxNumber: string | null;
  vatNumber: string | null;
  legalName: string | null;
  registrationNumber: string | null;
  invitation: { email: string | null; redirectUrl: string | null; created: string | null };
} {
  return {
    accountId: 'acc_test_001',
    merchantId: opts.merchantId,
    email: 'm@example.com',
    verified: opts.verified,
    acquiringEnabled: opts.verified,
    created: '2026-05-01T00:00:00Z',
    taxNumber: null,
    vatNumber: null,
    legalName: null,
    registrationNumber: null,
    invitation: { email: null, redirectUrl: null, created: null },
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('admin POST /viva/admin/connected-accounts/:id/sources', () => {
  beforeEach(() => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('1. merchant mode → 404', async () => {
    const { POST } = await import(
      '../../src/api/viva/admin/connected-accounts/[id]/sources/route.js'
    );

    const retrieveSpy = vi.spyOn(IsvAccounts.prototype, 'retrieveConnectedAccount');
    const ecomSpy = vi.spyOn(IsvSources.prototype, 'createEcommerceSource');

    const { res, status, lastJsonBody } = makeRes();
    await POST(
      makeReq({
        headers: { 'x-viva-admin-token': 'admin-test-token' },
        params: { id: 'acc_test_001' },
        body: {
          kind: 'ecommerce',
          domain: 'www.example.com',
          pathSuccess: 'success',
          pathFail: 'fail',
          name: 'Online Store',
        },
        config: makeConfig('merchant'),
      }),
      res,
    );

    expect(status).toHaveBeenCalledWith(404);
    expect(lastJsonBody()).toEqual({ error: 'Not Found' });
    expect(retrieveSpy).not.toHaveBeenCalled();
    expect(ecomSpy).not.toHaveBeenCalled();
  });

  it('2. ISV mode without reseller → 412 VIVA_RESELLER_CREDENTIALS_MISSING', async () => {
    const { POST } = await import(
      '../../src/api/viva/admin/connected-accounts/[id]/sources/route.js'
    );

    const retrieveSpy = vi.spyOn(IsvAccounts.prototype, 'retrieveConnectedAccount');

    const { res, status, lastJsonBody } = makeRes();
    await POST(
      makeReq({
        headers: { 'x-viva-admin-token': 'admin-test-token' },
        body: {
          kind: 'ecommerce',
          domain: 'www.example.com',
          pathSuccess: 'success',
          pathFail: 'fail',
          name: 'Online Store',
        },
        config: makeConfig('isv', { reseller: false }),
      }),
      res,
    );

    expect(status).toHaveBeenCalledWith(412);
    const body = lastJsonBody();
    expect(body['code']).toBe('VIVA_RESELLER_CREDENTIALS_MISSING');
    expect(body['error']).toBe('precondition_failed');
    expect(retrieveSpy).not.toHaveBeenCalled();
  });

  it('3. ISV mode, missing admin token → 401', async () => {
    const { POST } = await import(
      '../../src/api/viva/admin/connected-accounts/[id]/sources/route.js'
    );

    const { res, status, lastJsonBody } = makeRes();
    await POST(
      makeReq({
        headers: {}, // no x-viva-admin-token
        body: { kind: 'physical', name: 'Store 1' },
        // No adminToken in config — gate fails closed.
        config: { ...makeConfig('isv'), adminToken: undefined },
      }),
      res,
    );

    expect(status).toHaveBeenCalledWith(401);
    expect(lastJsonBody()).toEqual({ error: 'unauthorized', reason: 'admin-token-not-configured' });
  });

  it('4. ISV mode, account not verified → 409 VIVA_ACCOUNT_NOT_VERIFIED', async () => {
    vi.spyOn(IsvAccounts.prototype, 'retrieveConnectedAccount').mockImplementation(
      async () =>
        fakeAccount({ verified: false, merchantId: null }) as never,
    );
    const ecomSpy = vi.spyOn(IsvSources.prototype, 'createEcommerceSource');

    const { POST } = await import(
      '../../src/api/viva/admin/connected-accounts/[id]/sources/route.js'
    );

    const { res, status, lastJsonBody } = makeRes();
    await POST(
      makeReq({
        headers: { 'x-viva-admin-token': 'admin-test-token' },
        body: {
          kind: 'ecommerce',
          domain: 'www.example.com',
          pathSuccess: 'success',
          pathFail: 'fail',
          name: 'Online Store',
          sourceCode: '1234',
        },
        config: makeConfig('isv'),
      }),
      res,
    );

    expect(status).toHaveBeenCalledWith(409);
    expect(lastJsonBody()['code']).toBe('VIVA_ACCOUNT_NOT_VERIFIED');
    expect(ecomSpy).not.toHaveBeenCalled();
  });

  it("5. ISV mode, verified, kind='ecommerce' → calls createEcommerceSource, returns 201", async () => {
    const connectedMerchantId = 'connected-merchant-uuid-xyz';
    vi.spyOn(IsvAccounts.prototype, 'retrieveConnectedAccount').mockImplementation(
      async () =>
        fakeAccount({ verified: true, merchantId: connectedMerchantId }) as never,
    );

    // createEcommerceSource returns void — Viva responds with empty 200 body.
    // sourceCode and name come from the request input (defect #24 fix).
    const ecomSpy = vi
      .spyOn(IsvSources.prototype, 'createEcommerceSource')
      .mockImplementation(async () => undefined);

    const { POST } = await import(
      '../../src/api/viva/admin/connected-accounts/[id]/sources/route.js'
    );

    const { res, status, lastJsonBody } = makeRes();
    await POST(
      makeReq({
        headers: { 'x-viva-admin-token': 'admin-test-token' },
        params: { id: 'acc_test_001' },
        body: {
          kind: 'ecommerce',
          domain: 'www.example.com',
          pathSuccess: 'success',
          pathFail: 'fail',
          isSecure: true,
          name: 'Online Store',
          sourceCode: '4242',
        },
        config: makeConfig('isv'),
      }),
      res,
    );

    expect(ecomSpy).toHaveBeenCalledTimes(1);
    expect(ecomSpy).toHaveBeenCalledWith({
      domain: 'www.example.com',
      pathSuccess: 'success',
      pathFail: 'fail',
      isSecure: true,
      name: 'Online Store',
      sourceCode: '4242',
    });

    expect(status).toHaveBeenCalledWith(201);
    expect(lastJsonBody()).toEqual({
      sourceCode: '4242',
      name: 'Online Store',
      kind: 'ecommerce',
    });
  });

  it("6. ISV mode, verified, kind='physical' → calls createPhysicalSource, returns 201", async () => {
    vi.spyOn(IsvAccounts.prototype, 'retrieveConnectedAccount').mockImplementation(
      async () =>
        fakeAccount({
          verified: true,
          merchantId: 'connected-merchant-uuid-xyz',
        }) as never,
    );

    // createPhysicalSource returns void — sourceCode comes from request input.
    const physicalSpy = vi
      .spyOn(IsvSources.prototype, 'createPhysicalSource')
      .mockImplementation(async () => undefined);

    const { POST } = await import(
      '../../src/api/viva/admin/connected-accounts/[id]/sources/route.js'
    );

    const { res, status, lastJsonBody } = makeRes();
    await POST(
      makeReq({
        headers: { 'x-viva-admin-token': 'admin-test-token' },
        body: { kind: 'physical', name: 'Store 1', sourceCode: '5151' },
        config: makeConfig('isv'),
      }),
      res,
    );

    expect(physicalSpy).toHaveBeenCalledTimes(1);
    expect(physicalSpy).toHaveBeenCalledWith({
      name: 'Store 1',
      sourceCode: '5151',
    });
    expect(status).toHaveBeenCalledWith(201);
    expect(lastJsonBody()).toEqual({
      sourceCode: '5151',
      name: 'Store 1',
      kind: 'physical',
    });
  });

  it('7. ISV mode, invalid kind → 400', async () => {
    const retrieveSpy = vi.spyOn(IsvAccounts.prototype, 'retrieveConnectedAccount');

    const { POST } = await import(
      '../../src/api/viva/admin/connected-accounts/[id]/sources/route.js'
    );

    const { res, status, lastJsonBody } = makeRes();
    await POST(
      makeReq({
        headers: { 'x-viva-admin-token': 'admin-test-token' },
        body: { kind: 'tablet', name: 'whatever' },
        config: makeConfig('isv'),
      }),
      res,
    );

    expect(status).toHaveBeenCalledWith(400);
    expect(lastJsonBody()['error']).toBe('invalid_request');
    expect(retrieveSpy).not.toHaveBeenCalled();
  });

  it('8. ISV mode, Viva 4xx on POST /api/sources → 422 VIVA_SOURCE_CREATION_FAILED', async () => {
    vi.spyOn(IsvAccounts.prototype, 'retrieveConnectedAccount').mockImplementation(
      async () =>
        fakeAccount({
          verified: true,
          merchantId: 'connected-merchant-uuid-xyz',
        }) as never,
    );

    vi.spyOn(IsvSources.prototype, 'createEcommerceSource').mockImplementation(
      async () => {
        throw new VivaApiError({
          message: 'domain already registered',
          httpStatus: 400,
          vivaCode: 'SourceDomainConflict',
        });
      },
    );

    const { POST } = await import(
      '../../src/api/viva/admin/connected-accounts/[id]/sources/route.js'
    );

    const { res, status, lastJsonBody } = makeRes();
    await POST(
      makeReq({
        headers: { 'x-viva-admin-token': 'admin-test-token' },
        body: {
          kind: 'ecommerce',
          domain: 'www.example.com',
          pathSuccess: 'success',
          pathFail: 'fail',
          name: 'Online Store',
          sourceCode: '1234',
        },
        config: makeConfig('isv'),
      }),
      res,
    );

    expect(status).toHaveBeenCalledWith(422);
    const body = lastJsonBody();
    expect(body['code']).toBe('VIVA_SOURCE_CREATION_FAILED');
    expect(body['vivaStatus']).toBe(400);
    expect(body['message']).toBe('domain already registered');
  });

  it('regression: verified account uses account.merchantId (not config.reseller.merchantId) in Reseller Basic', async () => {
    const connectedMerchantId = 'connected-merchant-uuid-xyz';
    vi.spyOn(IsvAccounts.prototype, 'retrieveConnectedAccount').mockImplementation(
      async () =>
        fakeAccount({ verified: true, merchantId: connectedMerchantId }) as never,
    );

    // Inspect the BasicAuthClient passed to IsvSources by replacing the
    // constructor temporarily and capturing its config.
    let capturedAuthHeader: string | undefined;
    // createEcommerceSource returns void — capture BasicAuth header and return undefined.
    vi.spyOn(IsvSources.prototype, 'createEcommerceSource').mockImplementation(
      async function (this: IsvSources) {
        // The basic client is private; read via this index access for the test.
        const basic = (this as unknown as { basic: { ['authorizationHeader']: string } }).basic;
        capturedAuthHeader = basic['authorizationHeader'];
        return undefined;
      },
    );

    const { POST } = await import(
      '../../src/api/viva/admin/connected-accounts/[id]/sources/route.js'
    );

    const { res } = makeRes();
    await POST(
      makeReq({
        headers: { 'x-viva-admin-token': 'admin-test-token' },
        body: {
          kind: 'ecommerce',
          domain: 'www.example.com',
          pathSuccess: 'success',
          pathFail: 'fail',
          name: 'Online Store',
          sourceCode: '4242',
        },
        config: makeConfig('isv'),
      }),
      res,
    );

    // Reseller Basic = base64("resellerId:connectedMerchantId:resellerApiKey")
    expect(capturedAuthHeader).toBeDefined();
    const decoded = Buffer.from(
      capturedAuthHeader!.replace(/^Basic /, ''),
      'base64',
    ).toString('utf-8');
    // Username slot uses the CONNECTED merchant's id, not the platform's.
    expect(decoded).toContain(connectedMerchantId);
    expect(decoded).not.toContain('platform-merchant-uuid');
  });
});
