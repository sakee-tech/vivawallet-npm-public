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
  } = {},
): MedusaRequest<unknown, { id: string }> {
  return {
    headers: opts.headers ?? {},
    body: opts.body ?? {},
    params: opts.params ?? { id: 'acc_test_001' },
    scope: { resolve: (_k: string, _o?: unknown) => undefined },
  } as unknown as MedusaRequest<unknown, { id: string }>;
}

// ---------------------------------------------------------------------------
// Env save/restore
// ---------------------------------------------------------------------------

const VARS = [
  'VIVA_MODE',
  'VIVA_ADMIN_TOKEN',
  'VIVA_ENVIRONMENT',
  'VIVA_CLIENT_ID',
  'VIVA_CLIENT_SECRET',
  'VIVA_WEBHOOK_VERIFICATION_KEY',
  'VIVA_MERCHANT_ID',
  'VIVA_API_KEY',
  'VIVA_RESELLER_ID',
  'VIVA_RESELLER_MERCHANT_ID',
  'VIVA_RESELLER_API_KEY',
];
let saved: Record<string, string | undefined> = {};

function saveEnv() {
  for (const v of VARS) saved[v] = process.env[v];
}
function restoreEnv() {
  for (const v of VARS) {
    if (saved[v] === undefined) delete process.env[v];
    else process.env[v] = saved[v];
  }
}

function setBaseEnv(mode: 'merchant' | 'isv', opts: { reseller?: boolean } = {}): void {
  process.env['VIVA_MODE'] = mode;
  process.env['VIVA_ADMIN_TOKEN'] = 'admin-test-token';
  process.env['VIVA_ENVIRONMENT'] = 'demo';
  process.env['VIVA_CLIENT_ID'] = 'test-client';
  process.env['VIVA_CLIENT_SECRET'] = 'test-secret';
  process.env['VIVA_WEBHOOK_VERIFICATION_KEY'] = 'test-wvk';
  process.env['VIVA_MERCHANT_ID'] = 'test-legacy-merchant';
  process.env['VIVA_API_KEY'] = 'test-legacy-key';

  // Default ISV → reseller present unless explicitly opted out.
  const wantReseller = mode === 'isv' && opts.reseller !== false;
  if (wantReseller) {
    process.env['VIVA_RESELLER_ID'] = 'reseller-uuid-platform';
    process.env['VIVA_RESELLER_MERCHANT_ID'] = 'platform-merchant-uuid';
    process.env['VIVA_RESELLER_API_KEY'] = 'reseller-secret';
  } else {
    delete process.env['VIVA_RESELLER_ID'];
    delete process.env['VIVA_RESELLER_MERCHANT_ID'];
    delete process.env['VIVA_RESELLER_API_KEY'];
  }
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
    saveEnv();
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  });
  afterEach(() => {
    restoreEnv();
    vi.restoreAllMocks();
  });

  it('1. merchant mode → 404', async () => {
    setBaseEnv('merchant');
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
        },
      }),
      res,
    );

    expect(status).toHaveBeenCalledWith(404);
    expect(lastJsonBody()).toEqual({ error: 'Not Found' });
    expect(retrieveSpy).not.toHaveBeenCalled();
    expect(ecomSpy).not.toHaveBeenCalled();
  });

  it('2. ISV mode without reseller → 412 VIVA_RESELLER_CREDENTIALS_MISSING', async () => {
    setBaseEnv('isv', { reseller: false });
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
        },
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
    setBaseEnv('isv');
    const { POST } = await import(
      '../../src/api/viva/admin/connected-accounts/[id]/sources/route.js'
    );

    const { res, status, lastJsonBody } = makeRes();
    await POST(
      makeReq({
        headers: {}, // no x-viva-admin-token
        body: { kind: 'physical', name: 'Store 1' },
      }),
      res,
    );

    expect(status).toHaveBeenCalledWith(401);
    expect(lastJsonBody()).toEqual({ error: 'unauthorized' });
  });

  it('4. ISV mode, account not verified → 409 VIVA_ACCOUNT_NOT_VERIFIED', async () => {
    setBaseEnv('isv');

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
        },
      }),
      res,
    );

    expect(status).toHaveBeenCalledWith(409);
    expect(lastJsonBody()['code']).toBe('VIVA_ACCOUNT_NOT_VERIFIED');
    expect(ecomSpy).not.toHaveBeenCalled();
  });

  it("5. ISV mode, verified, kind='ecommerce' → calls createEcommerceSource, returns 201", async () => {
    setBaseEnv('isv');

    const connectedMerchantId = 'connected-merchant-uuid-xyz';
    vi.spyOn(IsvAccounts.prototype, 'retrieveConnectedAccount').mockImplementation(
      async () =>
        fakeAccount({ verified: true, merchantId: connectedMerchantId }) as never,
    );

    const ecomSpy = vi
      .spyOn(IsvSources.prototype, 'createEcommerceSource')
      .mockImplementation(async () => ({
        sourceCode: 4242,
        name: 'Online Store',
      }));

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
        },
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
    });

    expect(status).toHaveBeenCalledWith(201);
    expect(lastJsonBody()).toEqual({
      sourceCode: 4242,
      name: 'Online Store',
      kind: 'ecommerce',
    });
  });

  it("6. ISV mode, verified, kind='physical' → calls createPhysicalSource, returns 201", async () => {
    setBaseEnv('isv');

    vi.spyOn(IsvAccounts.prototype, 'retrieveConnectedAccount').mockImplementation(
      async () =>
        fakeAccount({
          verified: true,
          merchantId: 'connected-merchant-uuid-xyz',
        }) as never,
    );

    const physicalSpy = vi
      .spyOn(IsvSources.prototype, 'createPhysicalSource')
      .mockImplementation(async () => ({ sourceCode: 5151, name: 'Store 1' }));

    const { POST } = await import(
      '../../src/api/viva/admin/connected-accounts/[id]/sources/route.js'
    );

    const { res, status, lastJsonBody } = makeRes();
    await POST(
      makeReq({
        headers: { 'x-viva-admin-token': 'admin-test-token' },
        body: { kind: 'physical', name: 'Store 1', sourceCode: 5151 },
      }),
      res,
    );

    expect(physicalSpy).toHaveBeenCalledTimes(1);
    expect(physicalSpy).toHaveBeenCalledWith({
      name: 'Store 1',
      sourceCode: 5151,
    });
    expect(status).toHaveBeenCalledWith(201);
    expect(lastJsonBody()).toEqual({
      sourceCode: 5151,
      name: 'Store 1',
      kind: 'physical',
    });
  });

  it('7. ISV mode, invalid kind → 400', async () => {
    setBaseEnv('isv');

    const retrieveSpy = vi.spyOn(IsvAccounts.prototype, 'retrieveConnectedAccount');

    const { POST } = await import(
      '../../src/api/viva/admin/connected-accounts/[id]/sources/route.js'
    );

    const { res, status, lastJsonBody } = makeRes();
    await POST(
      makeReq({
        headers: { 'x-viva-admin-token': 'admin-test-token' },
        body: { kind: 'tablet', name: 'whatever' },
      }),
      res,
    );

    expect(status).toHaveBeenCalledWith(400);
    expect(lastJsonBody()['error']).toBe('invalid_request');
    expect(retrieveSpy).not.toHaveBeenCalled();
  });

  it('8. ISV mode, Viva 4xx on POST /api/sources → 422 VIVA_SOURCE_CREATION_FAILED', async () => {
    setBaseEnv('isv');

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
        },
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
    setBaseEnv('isv');

    const connectedMerchantId = 'connected-merchant-uuid-xyz';
    vi.spyOn(IsvAccounts.prototype, 'retrieveConnectedAccount').mockImplementation(
      async () =>
        fakeAccount({ verified: true, merchantId: connectedMerchantId }) as never,
    );

    // Inspect the BasicAuthClient passed to IsvSources by replacing the
    // constructor temporarily and capturing its config.
    let capturedAuthHeader: string | undefined;
    vi.spyOn(IsvSources.prototype, 'createEcommerceSource').mockImplementation(
      async function (this: IsvSources) {
        // The basic client is private; read via this index access for the test.
        const basic = (this as unknown as { basic: { ['authorizationHeader']: string } }).basic;
        capturedAuthHeader = basic['authorizationHeader'];
        return { sourceCode: 4242 };
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
        },
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
