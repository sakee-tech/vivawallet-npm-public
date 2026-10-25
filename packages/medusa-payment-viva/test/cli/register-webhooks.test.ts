/**
 * register-webhooks.test.ts — Integration tests for the CLI run() function.
 *
 * Probe-verified 2026-05-11: the ISV API has no list endpoint. The CLI now
 * always treats `current = []` and emits REGISTER actions for every event type.
 * Server-side limit overruns surface as HTTP 400 with `eventId: 3732`.
 *
 * Mode-aware (v0.2.0):
 *   - ISV mode (VIVA_MODE=isv): existing /isv/v1/webhooks POST flow.
 *   - Merchant mode (VIVA_MODE=merchant): GET /api/messages/config/token
 *     verification-key fetch + manual-setup instructions; --reconcile-drift
 *     prints "not supported" and exits 0.
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import { MockAgent } from 'undici';
import { run } from '../../src/cli/register-webhooks.js';
import type { RunOptions } from '../../src/cli/register-webhooks.js';

const DEMO_API_BASE = 'https://demo-api.vivapayments.com';
const DEMO_AUTH_BASE = 'https://demo-accounts.vivapayments.com';
const DEMO_LEGACY_BASE = 'https://demo.vivapayments.com';
const WEBHOOK_BASE = 'https://api.example.com';
const EXPECTED_WEBHOOK_URL = `${WEBHOOK_BASE}/viva/webhook`;

const VALID_ENV: NodeJS.ProcessEnv = {
  VIVA_MODE: 'isv',
  VIVA_ENVIRONMENT: 'demo',
  VIVA_ISV_CLIENT_ID: 'test-client-id',
  VIVA_ISV_CLIENT_SECRET: 'test-client-secret',
  VIVA_WEBHOOK_VERIFICATION_KEY: 'test-wvk',
  VIVA_WEBHOOK_BASE_URL: WEBHOOK_BASE,
  VIVA_MERCHANT_ID: 'test-legacy-merchant-uuid',
  VIVA_API_KEY: 'test-legacy-api-key',
};

const MERCHANT_ENV: NodeJS.ProcessEnv = {
  VIVA_MODE: 'merchant',
  VIVA_ENVIRONMENT: 'demo',
  VIVA_CLIENT_ID: 'merchant-client-id',
  VIVA_CLIENT_SECRET: 'merchant-client-secret',
  VIVA_WEBHOOK_VERIFICATION_KEY: 'placeholder-wvk',
  VIVA_WEBHOOK_BASE_URL: WEBHOOK_BASE,
  VIVA_MERCHANT_ID: 'merchant-uuid',
  VIVA_API_KEY: 'merchant-api-key',
};

const OPTS_DRY: RunOptions = { dryRun: true, apply: false, output: 'json' };
const OPTS_APPLY: RunOptions = { dryRun: false, apply: true, output: 'json' };

const TOKEN_RESPONSE = {
  access_token: 'mock-access-token',
  token_type: 'Bearer',
  expires_in: 3600,
};

interface RegisterMockOptions {
  /** How many POST /isv/v1/webhooks calls to mock. */
  registerCount?: number;
  /** 0-based index at which to inject a server failure. */
  registerFailAtIndex?: number;
  /** Viva-issued verification key returned by GET /isv/v1/webhooks/token.
   *  Defaults to VALID_ENV's key ('test-wvk') so the reconcile step passes. */
  vivaIssuedKey?: string;
  /** Make the verification-key fetch fail with HTTP 500. */
  verificationKeyFails?: boolean;
}

function buildMockAgent(opts: RegisterMockOptions = {}) {
  const agent = new MockAgent();
  agent.disableNetConnect();

  const authPool = agent.get(DEMO_AUTH_BASE);
  const apiPool = agent.get(DEMO_API_BASE);

  authPool
    .intercept({ method: 'POST', path: '/connect/token' })
    .reply(200, JSON.stringify(TOKEN_RESPONSE), {
      headers: { 'Content-Type': 'application/json' },
    });

  // GET /isv/v1/webhooks/token — Viva-issued ISV verification key (#17 reconcile).
  if (opts.verificationKeyFails) {
    apiPool
      .intercept({ method: 'GET', path: '/isv/v1/webhooks/token' })
      .reply(500, JSON.stringify({ status: 500, message: 'Internal Server Error' }), {
        headers: { 'Content-Type': 'application/json' },
      });
  } else {
    apiPool
      .intercept({ method: 'GET', path: '/isv/v1/webhooks/token' })
      .reply(200, JSON.stringify({ key: opts.vivaIssuedKey ?? 'test-wvk' }), {
        headers: { 'Content-Type': 'application/json' },
      });
  }

  const count = opts.registerCount ?? 0;
  for (let i = 0; i < count; i++) {
    if (opts.registerFailAtIndex === i) {
      // 400 is non-retryable (idempotent POST retries only 429/5xx), so the
      // mock interceptor count stays deterministic — mirrors the real #18
      // IsvCreateWebhookFailedInvalidEventTypeId rejection.
      apiPool
        .intercept({ method: 'POST', path: '/isv/v1/webhooks' })
        .reply(
          400,
          JSON.stringify({ status: 400, message: 'IsvCreateWebhookFailedInvalidEventTypeId' }),
          { headers: { 'Content-Type': 'application/json' } },
        );
    } else {
      // 204 No Content is the real success response.
      apiPool.intercept({ method: 'POST', path: '/isv/v1/webhooks' }).reply(204, '');
    }
  }

  return { agent, authPool, apiPool };
}

interface MerchantMockOptions {
  verificationKey?: string;
  /** Pascal vs lower case in body. */
  keyCasing?: 'Key' | 'key';
}

function buildMerchantMockAgent(opts: MerchantMockOptions = {}) {
  const agent = new MockAgent();
  agent.disableNetConnect();
  const legacyPool = agent.get(DEMO_LEGACY_BASE);
  const field = opts.keyCasing ?? 'Key';
  const body =
    opts.verificationKey === undefined
      ? null
      : { [field]: opts.verificationKey };

  legacyPool
    .intercept({ method: 'GET', path: '/api/messages/config/token' })
    .reply(
      200,
      body === null ? '' : JSON.stringify(body),
      { headers: { 'Content-Type': 'application/json' } },
    );

  return { agent, legacyPool };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('run() CLI integration — ISV mode (regression)', () => {
  it('1 — dry-run: 5 REGISTER in plan (no 4865), exit 1', async () => {
    const { agent } = buildMockAgent();

    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});

    const exitCode = await run(OPTS_DRY, VALID_ENV, agent);
    await agent.close();

    expect(exitCode).toBe(1);
  });

  it('2 — apply: registers 5 → exit 0; re-run also registers 5 (no list endpoint, plugin re-posts)', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});

    const { agent: agent1 } = buildMockAgent({ registerCount: 5 });
    const exitCode1 = await run(OPTS_APPLY, VALID_ENV, agent1);
    await agent1.close();
    expect(exitCode1).toBe(0);

    const { agent: agent2 } = buildMockAgent({ registerCount: 5 });
    const exitCode2 = await run(OPTS_APPLY, VALID_ENV, agent2);
    await agent2.close();
    expect(exitCode2).toBe(0);
  });

  it('3 — continue-on-error: one event rejected → others still attempted, exit 2 (#18)', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});

    // Fail the 4th of 5 events; the 5th must still be attempted (the bug
    // aborted the batch on first failure, stranding later events).
    const { agent } = buildMockAgent({ registerCount: 5, registerFailAtIndex: 3 });
    const exitCode = await run(OPTS_APPLY, VALID_ENV, agent);
    // All 5 POST interceptors consumed → every event attempted despite the failure.
    expect(() => agent.assertNoPendingInterceptors()).not.toThrow();
    await agent.close();

    expect(exitCode).toBe(2);
  });

  it('3b — env key mismatches Viva-issued ISV key → abort exit 3, no register (#17)', async () => {
    const errors: string[] = [];
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation((msg: unknown) => {
      errors.push(String(msg));
    });

    // Viva returns a different key than VALID_ENV's 'test-wvk'.
    const { agent } = buildMockAgent({ registerCount: 6, vivaIssuedKey: 'real-viva-key' });
    const exitCode = await run(OPTS_APPLY, VALID_ENV, agent);
    await agent.close();

    expect(exitCode).toBe(3);
    expect(errors.some((e) => e.includes('does not match the Viva-issued ISV key'))).toBe(true);
    expect(errors.some((e) => e.includes('real-viva-key'))).toBe(true);
  });

  it('3c — verification-key fetch fails → exit 2, no register (#17)', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});

    const { agent } = buildMockAgent({ registerCount: 6, verificationKeyFails: true });
    const exitCode = await run(OPTS_APPLY, VALID_ENV, agent);
    await agent.close();

    expect(exitCode).toBe(2);
  });

  it('4 — server returns 400 / eventId 3732 (max URLs per event reached) → exit 2', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});

    const agent = new MockAgent();
    agent.disableNetConnect();
    const authPool = agent.get(DEMO_AUTH_BASE);
    const apiPool = agent.get(DEMO_API_BASE);

    authPool
      .intercept({ method: 'POST', path: '/connect/token' })
      .reply(200, JSON.stringify(TOKEN_RESPONSE), {
        headers: { 'Content-Type': 'application/json' },
      });

    // Verification-key reconcile passes so the 400 register path is exercised.
    apiPool
      .intercept({ method: 'GET', path: '/isv/v1/webhooks/token' })
      .reply(200, JSON.stringify({ key: 'test-wvk' }), {
        headers: { 'Content-Type': 'application/json' },
      });

    apiPool
      .intercept({ method: 'POST', path: '/isv/v1/webhooks' })
      .reply(
        400,
        JSON.stringify({
          status: 400,
          message: 'SecurityCreateWebhookFailedLimitReached',
          eventId: 3732,
        }),
        { headers: { 'Content-Type': 'application/json' } },
      );

    const exitCode = await run(OPTS_APPLY, VALID_ENV, agent);
    await agent.close();
    expect(exitCode).toBe(2);
  });

  it('5 — missing VIVA_ISV_CLIENT_ID → exit 3', async () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});

    const envNoId: NodeJS.ProcessEnv = {
      VIVA_MODE: 'isv',
      VIVA_ISV_CLIENT_SECRET: 'secret',
      VIVA_WEBHOOK_VERIFICATION_KEY: 'key',
      VIVA_WEBHOOK_BASE_URL: WEBHOOK_BASE,
    };

    const exitCode = await run(OPTS_DRY, envNoId);
    expect(exitCode).toBe(3);
    expect(consoleError).toHaveBeenCalledWith(expect.stringMatching(/VIVA_CLIENT_ID/));
  });

  it('6 — missing VIVA_WEBHOOK_BASE_URL → exit 3', async () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});

    const envNoBase: NodeJS.ProcessEnv = {
      VIVA_MODE: 'isv',
      VIVA_ISV_CLIENT_ID: 'cid',
      VIVA_ISV_CLIENT_SECRET: 'secret',
      VIVA_WEBHOOK_VERIFICATION_KEY: 'key',
      VIVA_MERCHANT_ID: 'test-legacy-merchant-uuid',
      VIVA_API_KEY: 'test-legacy-api-key',
    };

    const exitCode = await run(OPTS_DRY, envNoBase);
    expect(exitCode).toBe(3);
    expect(consoleError).toHaveBeenCalledWith(expect.stringMatching(/VIVA_WEBHOOK_BASE_URL/));
  });

  it('7 — repeat apply: plugin re-posts every event (server is idempotency authority)', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});

    const { agent } = buildMockAgent({ registerCount: 6 });
    const exitCode = await run(OPTS_APPLY, VALID_ENV, agent);
    await agent.close();
    expect(exitCode).toBe(0);
  });
});

describe('run() CLI integration — merchant mode', () => {
  it('M1 — --apply: fetches verification key via GET /api/messages/config/token, prints human instructions, exit 0', async () => {
    const VK = 'merchant-wvk-applied';
    const { agent } = buildMerchantMockAgent({ verificationKey: VK });

    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});

    const exitCode = await run(
      { dryRun: false, apply: true, output: 'human' },
      MERCHANT_ENV,
      agent,
    );
    await agent.close();

    expect(exitCode).toBe(0);

    const printed = logSpy.mock.calls.map((c) => c.join(' ')).join('\n');
    expect(printed).toContain('Manual webhook setup required (merchant mode).');
    expect(printed).toContain('Transaction Payment Created (1796)');
    expect(printed).toContain('Transaction Reversal Created (1797)');
    expect(printed).toContain('Transaction Payment Failed (1798)');
    expect(printed).toContain('Order Updated (4865)');
    expect(printed).toContain(EXPECTED_WEBHOOK_URL);
    expect(printed).toContain(VK);
  });

  it('M2 — --dry-run: NO Basic-auth call, prints URLs + dry-run placeholder, exit 0', async () => {
    // No interceptors registered → any HTTP call would throw under MockAgent.
    const agent = new MockAgent();
    agent.disableNetConnect();

    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});

    const exitCode = await run(
      { dryRun: true, apply: false, output: 'human' },
      MERCHANT_ENV,
      agent,
    );
    await agent.close();

    expect(exitCode).toBe(0);
    const printed = logSpy.mock.calls.map((c) => c.join(' ')).join('\n');
    expect(printed).toContain('Manual webhook setup required (merchant mode).');
    expect(printed).toContain(EXPECTED_WEBHOOK_URL);
    expect(printed).toContain('<dry-run — verification key not fetched>');
  });

  it('M3 — --reconcile-drift in merchant mode: prints "not supported" message, exit 0', async () => {
    const agent = new MockAgent();
    agent.disableNetConnect();

    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});

    const exitCode = await run(
      { dryRun: false, apply: true, reconcileDrift: true, output: 'human' },
      MERCHANT_ENV,
      agent,
    );
    await agent.close();

    expect(exitCode).toBe(0);
    const printed = logSpy.mock.calls.map((c) => c.join(' ')).join('\n');
    expect(printed).toContain(
      '--reconcile-drift is not supported in merchant mode (manual setup only).',
    );
    expect(printed).toContain('ISV mode uses this flag against POST /isv/v1/webhooks.');
  });

  it('M4 — --output json + --apply in merchant mode: emits expected JSON shape', async () => {
    const VK = 'merchant-wvk-json';
    const { agent } = buildMerchantMockAgent({ verificationKey: VK });

    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});

    const exitCode = await run(
      { dryRun: false, apply: true, output: 'json' },
      MERCHANT_ENV,
      agent,
    );
    await agent.close();

    expect(exitCode).toBe(0);
    const printed = logSpy.mock.calls.map((c) => c.join(' ')).join('\n');
    const parsed = JSON.parse(printed) as {
      mode: string;
      verificationKey: string;
      events: { id: number; name: string; url: string }[];
    };

    expect(parsed.mode).toBe('merchant');
    expect(parsed.verificationKey).toBe(VK);
    expect(parsed.events).toHaveLength(4);
    expect(parsed.events.map((e) => e.id)).toEqual([1796, 1797, 1798, 4865]);
    expect(parsed.events.every((e) => e.url === EXPECTED_WEBHOOK_URL)).toBe(true);
    expect(parsed.events[0]!.name).toBe('Transaction Payment Created');
  });

  it('M5 — missing VIVA_WEBHOOK_BASE_URL in merchant mode → exit 3', async () => {
    const envNoBase: NodeJS.ProcessEnv = {
      VIVA_MODE: 'merchant',
      VIVA_ENVIRONMENT: 'demo',
      VIVA_CLIENT_ID: 'cid',
      VIVA_CLIENT_SECRET: 'sec',
      VIVA_WEBHOOK_VERIFICATION_KEY: 'placeholder',
      VIVA_MERCHANT_ID: 'mid',
      VIVA_API_KEY: 'apikey',
    };

    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(console, 'log').mockImplementation(() => {});

    const exitCode = await run(
      { dryRun: false, apply: true, output: 'human' },
      envNoBase,
    );

    expect(exitCode).toBe(3);
    expect(consoleError).toHaveBeenCalledWith(
      expect.stringMatching(/VIVA_WEBHOOK_BASE_URL/),
    );
  });

  it('M6 — tolerates lower-case `{ key }` field in legacy response', async () => {
    const VK = 'merchant-wvk-lower';
    const { agent } = buildMerchantMockAgent({
      verificationKey: VK,
      keyCasing: 'key',
    });

    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});

    const exitCode = await run(
      { dryRun: false, apply: true, output: 'json' },
      MERCHANT_ENV,
      agent,
    );
    await agent.close();

    expect(exitCode).toBe(0);
    const printed = logSpy.mock.calls.map((c) => c.join(' ')).join('\n');
    const parsed = JSON.parse(printed) as { verificationKey: string };
    expect(parsed.verificationKey).toBe(VK);
  });
});
