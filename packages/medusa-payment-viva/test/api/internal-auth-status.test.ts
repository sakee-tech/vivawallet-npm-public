/**
 * internal-auth-status.test.ts — Unit tests for GET /viva/internal/auth-status.
 *
 * Tests the route handler directly (no Medusa server required).
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { MedusaRequest, MedusaResponse } from '@medusajs/framework/http';
import type { VivaPluginConfig } from '../../src/config.js';
import { VIVA_PLUGIN_CONFIG_KEY } from '../../src/container.js';

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
  config?: VivaPluginConfig,
): MedusaRequest {
  const scope = {
    resolve: (key: string, opts?: unknown) => {
      if (key === VIVA_PLUGIN_CONFIG_KEY) return config;
      return scopeResolve ? scopeResolve(key, opts) : undefined;
    },
  };
  return { headers, scope } as unknown as MedusaRequest;
}

function makeConfig(opts: { adminToken?: string; environment?: 'demo' | 'production' } = {}): VivaPluginConfig {
  return {
    mode: 'isv',
    environment: opts.environment ?? 'demo',
    clientId: 'test-client',
    clientSecret: 'test-secret',
    webhookVerificationKey: 'test-key',
    legacyMerchantId: '',
    legacyApiKey: '',
    ...(opts.adminToken !== undefined ? { adminToken: opts.adminToken } : {}),
  };
}


// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('GET /viva/internal/auth-status', () => {
  beforeEach(() => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('returns 401 when X-Viva-Admin-Token header is missing', async () => {
    const { GET } = await import('../../src/api/viva/internal/auth-status/route.js');

    const { res, status } = makeRes();
    await GET(makeReq({}, undefined, makeConfig({ adminToken: 'secret123' })), res);
    expect(status).toHaveBeenCalledWith(401);
  });

  it('returns 401 with wrong token', async () => {
    const { GET } = await import('../../src/api/viva/internal/auth-status/route.js');

    const { res, status } = makeRes();
    await GET(
      makeReq({ 'x-viva-admin-token': 'wrong-token' }, undefined, makeConfig({ adminToken: 'correct-token' })),
      res,
    );
    expect(status).toHaveBeenCalledWith(401);
  });

  it('returns 200 with correct token', async () => {
    const token = 'super-secret-admin-token';
    const { GET } = await import('../../src/api/viva/internal/auth-status/route.js');

    const { res, status, json } = makeRes();
    await GET(
      makeReq({ 'x-viva-admin-token': token }, undefined, makeConfig({ adminToken: token, environment: 'demo' })),
      res,
    );
    expect(status).toHaveBeenCalledWith(200);

    const body = json.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(body.environment).toBe('demo');
    expect(typeof body.now).toBe('string');
  });

  it('returns 401 with reason=admin-token-not-configured when adminToken is absent', async () => {
    const { GET } = await import('../../src/api/viva/internal/auth-status/route.js');

    const { res, status, json } = makeRes();
    // Config present but adminToken not set.
    await GET(makeReq({ 'x-viva-admin-token': 'any-token' }, undefined, makeConfig()), res);
    expect(status).toHaveBeenCalledWith(401);

    const body = json.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(body.reason).toBe('admin-token-not-configured');
  });

  it('returns token_present: true when singleton strategy has a cached token', async () => {
    const token = 'admin-token-for-singleton-test';
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

    const config = makeConfig({ adminToken: token, environment: 'demo' });
    // Override clientId to match the expected cache-key format.
    const configWithClient: VivaPluginConfig = { ...config, clientId: 'client-123' };

    const { res, status, json } = makeRes();
    await GET(makeReq({ 'x-viva-admin-token': token }, scopeResolve, configWithClient), res);

    expect(status).toHaveBeenCalledWith(200);
    const body = json.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(body.token_present).toBe(true);
    expect(typeof body.token_expires_at).toBe('string');
    expect(typeof body.last_refresh_at).toBe('string');
    expect(body.environment).toBe('demo');
  });
});
