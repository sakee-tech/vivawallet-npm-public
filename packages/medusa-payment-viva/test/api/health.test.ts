/**
 * health.test.ts — Unit tests for GET /viva/webhook/health route handler.
 *
 * Tests the route handler directly (no Medusa server required).
 */

import { describe, it, expect, vi } from 'vitest';
import type { MedusaRequest, MedusaResponse } from '@medusajs/framework/http';
import { GET } from '../../src/api/viva/webhook/health/route.js';
import type { VivaPluginConfig } from '../../src/config.js';

// ---------------------------------------------------------------------------
// Helpers: mock req/res
// ---------------------------------------------------------------------------

function makeRes(): {
  res: MedusaResponse;
  status: ReturnType<typeof vi.fn>;
  json: ReturnType<typeof vi.fn>;
  setHeader: ReturnType<typeof vi.fn>;
  jsonBody: () => unknown;
  statusCode: () => number;
} {
  let _statusCode = 200;
  const _headers: Record<string, string> = {};
  let _body: unknown;

  const json = vi.fn((body: unknown) => {
    _body = body;
    return res;
  });
  const status = vi.fn((code: number) => {
    _statusCode = code;
    return { json, end: vi.fn() };
  });
  const setHeader = vi.fn((key: string, val: string) => {
    _headers[key] = val;
  });

  const res = { status, json, setHeader, headers: _headers } as unknown as MedusaResponse;

  return {
    res,
    status,
    json,
    setHeader,
    jsonBody: () => _body,
    statusCode: () => _statusCode,
  };
}

/**
 * makeReq — builds a MedusaRequest with a scope that resolves the plugin
 * config via container key (#21: config comes from DI, not process.env).
 */
function makeReq(config?: Partial<VivaPluginConfig>): MedusaRequest {
  const scope = {
    resolve: (key: string, _opts?: unknown): unknown => {
      if (key === 'vivaPluginConfig') return config;
      return undefined;
    },
  };
  return { scope } as unknown as MedusaRequest;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('GET /viva/webhook/health', () => {
  it('returns 200 with { ok: true }', async () => {
    const { res, status, json } = makeRes();
    await GET(makeReq(), res);
    expect(status).toHaveBeenCalledWith(200);
    const jsonArg = json.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(jsonArg.ok).toBe(true);
  });

  it('response includes timestamp', async () => {
    const { res, json } = makeRes();
    await GET(makeReq(), res);
    const jsonArg = json.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(typeof jsonArg.timestamp).toBe('string');
    const ts = new Date(jsonArg.timestamp as string).getTime();
    expect(ts).toBeGreaterThan(0);
  });

  it('response includes environment from config', async () => {
    const { res, json } = makeRes();
    // #21: environment comes from DI-resolved config, not process.env
    await GET(makeReq({ environment: 'production' } as VivaPluginConfig), res);
    const jsonArg = json.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(jsonArg.environment).toBe('production');
  });

  it('defaults environment to demo when config absent', async () => {
    const { res, json } = makeRes();
    await GET(makeReq(), res);
    const jsonArg = json.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(jsonArg.environment).toBe('demo');
  });

  it('sets Cache-Control: no-store', async () => {
    const { res, setHeader } = makeRes();
    await GET(makeReq(), res);
    expect(setHeader).toHaveBeenCalledWith('Cache-Control', 'no-store');
  });
});
