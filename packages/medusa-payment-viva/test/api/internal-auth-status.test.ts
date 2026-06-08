/**
 * internal-auth-status.test.ts — Unit tests for GET /viva/internal/auth-status.
 *
 * Tests the route handler directly (no Medusa server required).
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { MedusaRequest, MedusaResponse } from '@medusajs/framework/http';

// ---------------------------------------------------------------------------
// Helpers: mock req/res
// ---------------------------------------------------------------------------

function makeRes(): {
  res: MedusaResponse;
  status: ReturnType<typeof vi.fn>;
  json: ReturnType<typeof vi.fn>;
  setHeader: ReturnType<typeof vi.fn>;
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
    return { json: jsonFn, end: vi.fn() };
  });
  const setHeaderFn = vi.fn();

  const res = { status: statusFn, json: jsonFn, setHeader: setHeaderFn } as unknown as MedusaResponse;
  return {
    res,
    status: statusFn,
    json: jsonFn,
    setHeader: setHeaderFn,
    lastJsonBody: () => _lastBody,
    lastStatusCode: () => _lastCode,
  };
}

function makeReq(
  headers: Record<string, string> = {},
  scopeResolve?: (key: string, opts?: unknown) => unknown,
): MedusaRequest {
  const scope = scopeResolve
    ? { resolve: (key: string, opts?: unknown) => scopeResolve(key, opts) }
    : { resolve: (_key: string, _opts?: unknown) => undefined };
  return { headers, scope } as unknown as MedusaRequest;
}

// ---------------------------------------------------------------------------
// Save/restore env
// ---------------------------------------------------------------------------

let savedVars: Record<string, string | undefined> = {};
const VARS = ['VIVA_ADMIN_TOKEN', 'VIVA_ENVIRONMENT', 'VIVA_ISV_CLIENT_ID', 'VIVA_ISV_CLIENT_SECRET', 'VIVA_WEBHOOK_VERIFICATION_KEY'];

function saveEnv() {
  for (const v of VARS) savedVars[v] = process.env[v];
}
function restoreEnv() {
  for (const v of VARS) {
    if (savedVars[v] === undefined) delete process.env[v];
    else process.env[v] = savedVars[v];
  }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('GET /viva/internal/auth-status', () => {
  beforeEach(saveEnv);
  afterEach(restoreEnv);

  it('returns 401 when X-Viva-Admin-Token header is missing', async () => {
    process.env['VIVA_ADMIN_TOKEN'] = 'secret123';
    // Dynamic import to avoid module-level env capture issues
    const { GET } = await import('../../src/api/viva/internal/auth-status/route.js');

    const { res, status } = makeRes();
    await GET(makeReq(), res);
    expect(status).toHaveBeenCalledWith(401);
  });

  it('returns 401 with wrong token', async () => {
    process.env['VIVA_ADMIN_TOKEN'] = 'correct-token';
    const { GET } = await import('../../src/api/viva/internal/auth-status/route.js');

    const { res, status } = makeRes();
    await GET(makeReq({ 'x-viva-admin-token': 'wrong-token' }), res);
    expect(status).toHaveBeenCalledWith(401);
  });

  it('returns 200 with correct token', async () => {
    const token = 'super-secret-admin-token';
    process.env['VIVA_ADMIN_TOKEN'] = token;
    process.env['VIVA_ENVIRONMENT'] = 'demo';
    process.env['VIVA_ISV_CLIENT_ID'] = 'test-client';
    process.env['VIVA_ISV_CLIENT_SECRET'] = 'test-secret';
    process.env['VIVA_WEBHOOK_VERIFICATION_KEY'] = 'test-key';

    // Re-import to pick up new env
    const { GET } = await import('../../src/api/viva/internal/auth-status/route.js');

    const { res, status, json } = makeRes();
    await GET(makeReq({ 'x-viva-admin-token': token }), res);
    expect(status).toHaveBeenCalledWith(200);

    const body = json.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(body.environment).toBe('demo');
    expect(typeof body.now).toBe('string');
  });

  it('returns 401 with reason=admin-token-not-configured when VIVA_ADMIN_TOKEN is unset', async () => {
    delete process.env['VIVA_ADMIN_TOKEN'];
    const { GET } = await import('../../src/api/viva/internal/auth-status/route.js');

    const { res, status, json } = makeRes();
    await GET(makeReq({ 'x-viva-admin-token': 'any-token' }), res);
    expect(status).toHaveBeenCalledWith(401);

    const body = json.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(body.reason).toBe('admin-token-not-configured');
  });

  it('returns token_present: true when singleton strategy has a cached token', async () => {
    const token = 'admin-token-for-singleton-test';
    process.env['VIVA_ADMIN_TOKEN'] = token;
    process.env['VIVA_ENVIRONMENT'] = 'demo';
    process.env['VIVA_ISV_CLIENT_ID'] = 'client-123';
    process.env['VIVA_ISV_CLIENT_SECRET'] = 'secret-456';
    process.env['VIVA_WEBHOOK_VERIFICATION_KEY'] = 'wh-key';

    const { GET } = await import('../../src/api/viva/internal/auth-status/route.js');
    const { VIVA_OAUTH2_STRATEGY_KEY } = await import('../../src/loaders/viva-oauth2-strategy.js');

    // Build a mock strategy whose tokenCache already holds a valid token entry.
    const futureExpiry = Date.now() + 3600 * 1000;
    const mockTokenCache = {
      get: vi.fn(async (_key: string) => ({
        access_token: 'bearer-abc',
        expires_at: futureExpiry,
        scope: 'api',
      })),
      set: vi.fn(),
      delete: vi.fn(),
    };
    const mockStrategy = { tokenCache: mockTokenCache };

    // Simulate req.scope.resolve returning our mock strategy for the known key.
    const scopeResolve = (key: string, _opts?: unknown) =>
      key === VIVA_OAUTH2_STRATEGY_KEY ? mockStrategy : undefined;

    const { res, status, json } = makeRes();
    await GET(makeReq({ 'x-viva-admin-token': token }, scopeResolve), res);

    expect(status).toHaveBeenCalledWith(200);
    const body = json.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(body.token_present).toBe(true);
    expect(typeof body.token_expires_at).toBe('string');
    expect(typeof body.last_refresh_at).toBe('string');
    expect(body.environment).toBe('demo');
  });
});
