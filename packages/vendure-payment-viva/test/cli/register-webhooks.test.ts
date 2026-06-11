/**
 * test/cli/register-webhooks.test.ts — vendure-viva-register-webhooks CLI tests.
 *
 * Probe-verified 2026-05-11: the ISV API has no list/deactivate endpoints.
 * The CLI now treats `current = []` and emits REGISTER actions for every event
 * type on every run; the server is the idempotency authority.
 *
 * Mode coverage (v0.2.0 slice C):
 *   - ISV mode (VIVA_MODE=isv) — register-webhook flow (existing tests).
 *   - VIVA_MODE unset → defaults to MERCHANT (matches plugin runtime default;
 *     fixed in v0.2.2 — CLI previously defaulted to 'isv' which silently
 *     dispatched ISV-only API calls for unset operators).
 *   - Merchant mode (VIVA_MODE=merchant) — manual setup printout + verification
 *     key fetch via BasicAuthClient.fetchWebhookVerificationKey().
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { VivaApiError } from '@sakeetech/viva-payments-core/errors';

const isvMock = {
  registerWebhook: vi.fn<() => Promise<void>>(),
  getVerificationKey: vi.fn<() => Promise<{ key: string }>>(),
};

const basicAuthMock = {
  fetchWebhookVerificationKey: vi.fn<() => Promise<string>>(),
};

vi.mock('@sakeetech/viva-payments-core/isv', () => {
  return {
    IsvWebhooks: vi.fn().mockImplementation(() => isvMock),
    IsvHttpClient: vi.fn().mockImplementation(() => ({})),
  };
});

vi.mock('@sakeetech/viva-payments-core/auth', () => {
  return {
    OAuth2ClientCredentialsStrategy: vi.fn().mockImplementation(() => ({
      getBearerToken: vi.fn().mockResolvedValue('mock-token'),
      name: 'oauth2-client-credentials',
    })),
    InMemoryTokenCache: vi.fn().mockImplementation(() => ({
      get: vi.fn().mockResolvedValue(null),
      set: vi.fn(),
      del: vi.fn(),
    })),
    AsyncMutex: vi.fn().mockImplementation(() => ({})),
  };
});

vi.mock('@sakeetech/viva-payments-core/legacy', () => {
  return {
    BasicAuthClient: vi.fn().mockImplementation(() => basicAuthMock),
  };
});

import { run } from '../../src/cli/register-webhooks.js';
import type { RunOptions } from '../../src/cli/types.js';

const BASE_ENV: NodeJS.ProcessEnv = {
  VIVA_MODE: 'isv',
  VIVA_ISV_CLIENT_ID: 'test-client-id',
  VIVA_ISV_CLIENT_SECRET: 'test-client-secret',
  VIVA_ENVIRONMENT: 'demo',
  VIVA_WEBHOOK_URL: 'https://api.example.com/viva/webhook',
  VIVA_WEBHOOK_VERIFICATION_KEY: 'test-verify-key',
};

const MERCHANT_ENV: NodeJS.ProcessEnv = {
  VIVA_MODE: 'merchant',
  VIVA_ENVIRONMENT: 'demo',
  VIVA_MERCHANT_ID: 'merchant-uuid',
  VIVA_API_KEY: 'merchant-api-key',
  VIVA_WEBHOOK_URL: 'https://api.example.com/viva/webhook',
};

describe('register-webhooks CLI', () => {
  beforeEach(() => {
    isvMock.registerWebhook.mockReset();
    isvMock.getVerificationKey.mockReset();
    isvMock.registerWebhook.mockResolvedValue(undefined);
    // Default: Viva-issued key matches BASE_ENV's VIVA_WEBHOOK_VERIFICATION_KEY
    // so the reconcile step passes and tests exercise the registration path.
    isvMock.getVerificationKey.mockResolvedValue({ key: 'test-verify-key' });
    basicAuthMock.fetchWebhookVerificationKey.mockReset();
    basicAuthMock.fetchWebhookVerificationKey.mockResolvedValue('viva-issued-key-uuid');
  });

  it('dry-run: returns exit 1 because every run emits 6 REGISTER actions (no list endpoint)', async () => {
    const opts: RunOptions = { dryRun: true, apply: false, output: 'text' };
    const code = await run(opts, BASE_ENV);
    expect(code).toBe(1);
    expect(isvMock.registerWebhook).not.toHaveBeenCalled();
  });

  it('dry-run output=json produces valid JSON with plan array', async () => {
    const logs: string[] = [];
    const origLog = console.log;
    console.log = (msg: string) => logs.push(msg);
    try {
      const opts: RunOptions = { dryRun: true, apply: false, output: 'json' };
      await run(opts, BASE_ENV);
    } finally {
      console.log = origLog;
    }
    const parsed = JSON.parse(logs.join(''));
    expect(Array.isArray(parsed.plan)).toBe(true);
    expect(typeof parsed.hasFatalError).toBe('boolean');
  });

  it('env key absent → aborts (exit 3) and surfaces the Viva-issued key, no UUID invented (#17)', async () => {
    const envWithoutKey = { ...BASE_ENV };
    delete envWithoutKey['VIVA_WEBHOOK_VERIFICATION_KEY'];
    isvMock.getVerificationKey.mockResolvedValue({ key: 'viva-issued-real-key' });

    const errors: string[] = [];
    const origError = console.error;
    console.error = (msg: string) => errors.push(msg);
    try {
      const opts: RunOptions = { dryRun: true, apply: false, output: 'text' };
      const code = await run(opts, envWithoutKey);
      expect(code).toBe(3);
    } finally {
      console.error = origError;
    }
    expect(errors.some((e) => e.includes('VIVA_WEBHOOK_VERIFICATION_KEY is not set'))).toBe(true);
    expect(errors.some((e) => e.includes('viva-issued-real-key'))).toBe(true);
    expect(isvMock.registerWebhook).not.toHaveBeenCalled();
  });

  it('env key mismatches the Viva-issued key → aborts (exit 3), no registration', async () => {
    isvMock.getVerificationKey.mockResolvedValue({ key: 'the-real-viva-key' });
    // BASE_ENV's VIVA_WEBHOOK_VERIFICATION_KEY = 'test-verify-key' ≠ above.

    const errors: string[] = [];
    const origError = console.error;
    console.error = (msg: string) => errors.push(msg);
    try {
      const opts: RunOptions = { dryRun: false, apply: true, output: 'text' };
      const code = await run(opts, BASE_ENV);
      expect(code).toBe(3);
    } finally {
      console.error = origError;
    }
    expect(errors.some((e) => e.includes('does not match the Viva-issued ISV key'))).toBe(true);
    expect(errors.some((e) => e.includes('the-real-viva-key'))).toBe(true);
    expect(isvMock.registerWebhook).not.toHaveBeenCalled();
  });

  it('verification-key fetch fails → exit 2, no registration', async () => {
    isvMock.getVerificationKey.mockRejectedValue(
      Object.assign(new VivaApiError('boom', 500, undefined), { httpStatus: 500 }),
    );
    const origError = console.error;
    console.error = () => {};
    try {
      const opts: RunOptions = { dryRun: false, apply: true, output: 'text' };
      const code = await run(opts, BASE_ENV);
      expect(code).toBe(2);
    } finally {
      console.error = origError;
    }
    expect(isvMock.registerWebhook).not.toHaveBeenCalled();
  });

  it('apply happy path: registers all 6 event types, exit 0', async () => {
    const opts: RunOptions = { dryRun: false, apply: true, output: 'text' };
    const code = await run(opts, BASE_ENV);
    expect(code).toBe(0);
    expect(isvMock.registerWebhook).toHaveBeenCalledTimes(6);
    const registeredIds = isvMock.registerWebhook.mock.calls.map(
      (call) => (call[0] as { eventTypeId: number }).eventTypeId,
    );
    expect(registeredIds.sort((a, b) => a - b)).toEqual([1796, 1797, 1798, 4865, 8193, 8194]);
  });

  it('apply with 409 conflict → counts as no-change, exit 0', async () => {
    const err409 = Object.assign(new VivaApiError('conflict', 409, undefined), { httpStatus: 409 });
    isvMock.registerWebhook.mockRejectedValue(err409);

    const opts: RunOptions = { dryRun: false, apply: true, output: 'text' };
    const code = await run(opts, BASE_ENV);
    expect(code).toBe(0);
  });

  it('Viva 4xx (not 409) → logs error, returns exit 2', async () => {
    const err422 = Object.assign(new VivaApiError('unprocessable', 422, undefined), { httpStatus: 422 });
    isvMock.registerWebhook.mockRejectedValue(err422);

    const errors: string[] = [];
    const origError = console.error;
    console.error = (msg: string) => errors.push(msg);
    try {
      const opts: RunOptions = { dryRun: false, apply: true, output: 'text' };
      const code = await run(opts, BASE_ENV);
      expect(code).toBe(2);
    } finally {
      console.error = origError;
    }
  });

  it('Viva 5xx → retries, still failing → exit 2', async () => {
    const err500 = Object.assign(new VivaApiError('server error', 500, undefined), { httpStatus: 500 });
    isvMock.registerWebhook.mockRejectedValue(err500);

    const opts: RunOptions = { dryRun: false, apply: true, output: 'text' };
    const code = await run(opts, BASE_ENV);
    expect(code).toBe(2);
    expect(isvMock.registerWebhook.mock.calls.length).toBeGreaterThanOrEqual(2);
  });

  it('--reconcile-drift logs the deprecation warning and is a no-op (no deactivate endpoint)', async () => {
    const warns: string[] = [];
    const origWarn = console.warn;
    console.warn = (msg: string) => warns.push(msg);
    try {
      const opts: RunOptions = {
        dryRun: true,
        apply: false,
        reconcileDrift: true,
        output: 'text',
      };
      await run(opts, BASE_ENV);
    } finally {
      console.warn = origWarn;
    }
    expect(warns.some((w) => w.includes('--reconcile-drift'))).toBe(true);
  });

  it('missing VIVA_ISV_CLIENT_ID → exit 3', async () => {
    const env = { ...BASE_ENV };
    delete env['VIVA_ISV_CLIENT_ID'];
    const opts: RunOptions = { dryRun: true, apply: false, output: 'text' };
    const code = await run(opts, env);
    expect(code).toBe(3);
  });

  it('missing VIVA_WEBHOOK_URL → exit 3', async () => {
    const env = { ...BASE_ENV };
    delete env['VIVA_WEBHOOK_URL'];
    const opts: RunOptions = { dryRun: true, apply: false, output: 'text' };
    const code = await run(opts, env);
    expect(code).toBe(3);
  });

  it('webhookUrl option overrides env VIVA_WEBHOOK_URL', async () => {
    const env = { ...BASE_ENV };
    delete env['VIVA_WEBHOOK_URL'];
    const opts: RunOptions = {
      dryRun: true,
      apply: false,
      output: 'text',
      webhookUrl: 'https://override.example.com/viva/webhook',
    };
    const code = await run(opts, env);
    expect(code).toBe(1);
  });

  // ---------------------------------------------------------------------------
  // Merchant-mode tests (v0.2.0 slice C)
  // ---------------------------------------------------------------------------

  describe('merchant mode (VIVA_MODE=merchant)', () => {
    it('--apply: fetches verification key + prints URLs + exit 0', async () => {
      const logs: string[] = [];
      const origLog = console.log;
      console.log = (msg: string) => logs.push(msg);
      try {
        const opts: RunOptions = { dryRun: false, apply: true, output: 'text' };
        const code = await run(opts, MERCHANT_ENV);
        expect(code).toBe(0);
      } finally {
        console.log = origLog;
      }
      expect(basicAuthMock.fetchWebhookVerificationKey).toHaveBeenCalledTimes(1);
      // ISV register flow not called.
      expect(isvMock.registerWebhook).not.toHaveBeenCalled();
      // Manual instructions printed.
      const all = logs.join('\n');
      expect(all).toContain('Manual webhook setup');
      expect(all).toContain('Transaction Payment Created');
      expect(all).toContain('1796');
      expect(all).toContain('viva-issued-key-uuid');
    });

    it('--dry-run: prints URLs without fetching key, exit 0', async () => {
      const logs: string[] = [];
      const origLog = console.log;
      console.log = (msg: string) => logs.push(msg);
      try {
        const opts: RunOptions = { dryRun: true, apply: false, output: 'text' };
        const code = await run(opts, MERCHANT_ENV);
        expect(code).toBe(0);
      } finally {
        console.log = origLog;
      }
      expect(basicAuthMock.fetchWebhookVerificationKey).not.toHaveBeenCalled();
      const all = logs.join('\n');
      expect(all).toContain('Manual webhook setup');
      expect(all).toContain('<dry-run — verification key not fetched>');
    });

    it('--reconcile-drift: prints not-supported message, exit 0, no fetch', async () => {
      const logs: string[] = [];
      const origLog = console.log;
      console.log = (msg: string) => logs.push(msg);
      try {
        const opts: RunOptions = {
          dryRun: false,
          apply: false,
          reconcileDrift: true,
          output: 'text',
        };
        const code = await run(opts, MERCHANT_ENV);
        expect(code).toBe(0);
      } finally {
        console.log = origLog;
      }
      expect(basicAuthMock.fetchWebhookVerificationKey).not.toHaveBeenCalled();
      const all = logs.join('\n');
      expect(all).toContain('not supported in merchant mode');
    });

    it('--apply --output json: emits structured JSON with verificationKey + 4 events', async () => {
      const logs: string[] = [];
      const origLog = console.log;
      console.log = (msg: string) => logs.push(msg);
      try {
        const opts: RunOptions = { dryRun: false, apply: true, output: 'json' };
        const code = await run(opts, MERCHANT_ENV);
        expect(code).toBe(0);
      } finally {
        console.log = origLog;
      }
      const parsed = JSON.parse(logs.join(''));
      expect(parsed.mode).toBe('merchant');
      expect(parsed.verificationKey).toBe('viva-issued-key-uuid');
      expect(Array.isArray(parsed.events)).toBe(true);
      expect(parsed.events).toHaveLength(4);
      const ids = parsed.events.map((e: { id: number }) => e.id).sort((a: number, b: number) => a - b);
      expect(ids).toEqual([1796, 1797, 1798, 4865]);
    });

    it('--apply with missing VIVA_MERCHANT_ID → exit 3', async () => {
      const env = { ...MERCHANT_ENV };
      delete env['VIVA_MERCHANT_ID'];
      const errors: string[] = [];
      const origError = console.error;
      console.error = (msg: string) => errors.push(msg);
      try {
        const opts: RunOptions = { dryRun: false, apply: true, output: 'text' };
        const code = await run(opts, env);
        expect(code).toBe(3);
      } finally {
        console.error = origError;
      }
      expect(basicAuthMock.fetchWebhookVerificationKey).not.toHaveBeenCalled();
    });

    it('--apply with Viva error fetching key → exit 2', async () => {
      const err500 = Object.assign(new VivaApiError('server error', 500, undefined), { httpStatus: 500 });
      basicAuthMock.fetchWebhookVerificationKey.mockRejectedValueOnce(err500);
      const errors: string[] = [];
      const origError = console.error;
      console.error = (msg: string) => errors.push(msg);
      try {
        const opts: RunOptions = { dryRun: false, apply: true, output: 'text' };
        const code = await run(opts, MERCHANT_ENV);
        expect(code).toBe(2);
      } finally {
        console.error = origError;
      }
    });

    it('missing VIVA_WEBHOOK_URL → exit 3 (mode-agnostic)', async () => {
      const env = { ...MERCHANT_ENV };
      delete env['VIVA_WEBHOOK_URL'];
      const opts: RunOptions = { dryRun: true, apply: false, output: 'text' };
      const code = await run(opts, env);
      expect(code).toBe(3);
    });
  });

  // ---------------------------------------------------------------------------
  // Default-mode regression (v0.2.2 fix)
  //
  // Prior to v0.2.2 the CLI defaulted to 'isv' when VIVA_MODE was unset,
  // which silently dispatched ISV-only API calls for operators who were
  // actually running in merchant mode. The plugin runtime defaults to
  // 'merchant'; the CLI must agree.
  // ---------------------------------------------------------------------------

  describe('VIVA_MODE unset', () => {
    it('defaults to merchant (matches plugin runtime default, NOT isv)', async () => {
      const env: NodeJS.ProcessEnv = {
        // VIVA_MODE deliberately omitted.
        VIVA_ENVIRONMENT: 'demo',
        VIVA_MERCHANT_ID: 'merchant-uuid',
        VIVA_API_KEY: 'merchant-api-key',
        VIVA_WEBHOOK_URL: 'https://api.example.com/viva/webhook',
      };
      const logs: string[] = [];
      const origLog = console.log;
      console.log = (msg: string) => logs.push(msg);
      try {
        const opts: RunOptions = { dryRun: false, apply: true, output: 'text' };
        const code = await run(opts, env);
        expect(code).toBe(0);
      } finally {
        console.log = origLog;
      }
      // Merchant-mode path taken: BasicAuthClient fetched the key, ISV
      // registerWebhook was NOT called.
      expect(basicAuthMock.fetchWebhookVerificationKey).toHaveBeenCalledTimes(1);
      expect(isvMock.registerWebhook).not.toHaveBeenCalled();
      expect(logs.join('\n')).toContain('Manual webhook setup');
    });
  });
});
