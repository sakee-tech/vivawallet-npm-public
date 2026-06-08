/**
 * health.test.ts — Unit tests for GET /viva/webhook/health route handler.
 *
 * Tests the route handler directly (no Medusa server required).
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { MedusaRequest, MedusaResponse } from '@medusajs/framework/http';
import { GET } from '../../src/api/viva/webhook/health/route.js';

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

function makeReq(): MedusaRequest {
  return {} as unknown as MedusaRequest;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('GET /viva/webhook/health', () => {
  let originalEnv: string | undefined;

  beforeEach(() => {
    originalEnv = process.env['VIVA_ENVIRONMENT'];
  });

  afterEach(() => {
    if (originalEnv === undefined) {
      delete process.env['VIVA_ENVIRONMENT'];
    } else {
      process.env['VIVA_ENVIRONMENT'] = originalEnv;
    }
  });

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

  it('response includes environment from VIVA_ENVIRONMENT', async () => {
    process.env['VIVA_ENVIRONMENT'] = 'production';
    const { res, json } = makeRes();
    await GET(makeReq(), res);
    const jsonArg = json.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(jsonArg.environment).toBe('production');
  });

  it('defaults environment to demo when VIVA_ENVIRONMENT not set', async () => {
    delete process.env['VIVA_ENVIRONMENT'];
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
