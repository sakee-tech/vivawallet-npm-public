/**
 * test/plugin/bootstrap.test.ts — VivaBootstrap warmup tests.
 *
 * Tests the onApplicationBootstrap() behaviour:
 * 1. Happy path: token fetched, cache populated, app boots.
 * 2. Viva 5xx: app boots, warning logged, retry scheduled, token cache empty.
 * 3. Network timeout: app boots, warning logged, retry scheduled.
 * 4. Lazy-fetch fallback: after failed bootstrap the strategy can still fetch
 *    a token on demand (simulating createPayment-time auth fetch).
 *
 * All HTTP is intercepted via undici MockAgent injected into the strategy's
 * `dispatcher` option — no live network calls.
 *
 * The retry delay (10s) is bypassed by mocking setTimeout so tests run at
 * test speed. vi.useFakeTimers() lets us control the scheduler.
 */

import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { MockAgent } from 'undici';
import type { Dispatcher } from 'undici';
import {
  OAuth2ClientCredentialsStrategy,
  InMemoryTokenCache,
  AsyncMutex,
} from '@sakeetech/viva-payments-core/auth';
import { Logger } from '@vendure/core';
import { VivaBootstrap } from '../../src/loaders/bootstrap.js';
import type { VivaPaymentPluginOptions } from '../../src/types.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DEMO_AUTH_HOST = 'https://demo-accounts.vivapayments.com';
const TOKEN_PATH = '/connect/token';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeOptions(overrides: Partial<VivaPaymentPluginOptions> = {}): VivaPaymentPluginOptions {
  return {
    mode: 'isv' as const,

    clientId: 'test-id',
    clientSecret: 'test-secret',
    onboardingReturnUrl: 'https://example.com/onboarding-return',
    environment: 'demo',
    webhookVerificationKey: 'verify-key',
    legacyMerchantId: 'test-legacy-merchant-uuid',
    legacyApiKey: 'test-legacy-api-key',
    successUrl: 'https://example.com/success',
    failureUrl: 'https://example.com/failure',
    ...overrides,
  };
}

function makeTokenBody() {
  return {
    access_token: 'tok_bootstrap_test',
    expires_in: 3600,
    token_type: 'Bearer',
    scope: 'urn:viva:payments:core',
  };
}

/** Build a strategy with a MockAgent dispatcher wired in. */
function buildStrategy(agent: MockAgent, cache?: InMemoryTokenCache) {
  const mutex = new AsyncMutex();
  const tokenCache = cache ?? new InMemoryTokenCache();
  const fetchImpl = (url: RequestInfo | URL, init?: RequestInit) => {
    return fetch(url, {
      ...init,
      // @ts-expect-error undici dispatcher option
      dispatcher: agent,
    });
  };
  const strategy = new OAuth2ClientCredentialsStrategy({
    environment: 'demo',
    clientId: 'test-id',
    clientSecret: 'test-secret',
    cache: tokenCache,
    mutex,
    fetchImpl,
    dispatcher: agent as unknown as Dispatcher,
  });
  return { strategy, tokenCache };
}

/** Build a VivaBootstrap instance from already-constructed deps. */
function buildBootstrap(options: VivaPaymentPluginOptions, strategy: OAuth2ClientCredentialsStrategy) {
  // VivaBootstrap's constructor parameters are resolved by NestJS DI;
  // in tests we pass them directly.
  return new VivaBootstrap(options, strategy);
}

// ---------------------------------------------------------------------------
// Test lifecycle
// ---------------------------------------------------------------------------

beforeEach(() => {
  vi.useFakeTimers();
  // Silence Logger output in tests.
  vi.spyOn(Logger, 'info').mockReturnValue(undefined);
  vi.spyOn(Logger, 'warn').mockReturnValue(undefined);
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('VivaBootstrap.onApplicationBootstrap', () => {
  it('happy path: token fetched and cached after bootstrap', async () => {
    const agent = new MockAgent();
    agent.disableNetConnect();
    const pool = agent.get(DEMO_AUTH_HOST);
    pool.intercept({ path: TOKEN_PATH, method: 'POST' }).reply(200, makeTokenBody(), {
      headers: { 'content-type': 'application/json' },
    });

    const { strategy, tokenCache } = buildStrategy(agent);
    const bootstrap = buildBootstrap(makeOptions(), strategy);

    await bootstrap.onApplicationBootstrap();

    // Token should now be in the cache.
    const cached = await tokenCache.get('viva:isv:token:test-id:demo');
    expect(cached).not.toBeNull();
    expect(cached?.access_token).toBe('tok_bootstrap_test');
    expect(bootstrap.lastWarmupFailed).toBe(false);
    expect(Logger.info).toHaveBeenCalledWith(
      expect.stringContaining('cached successfully'),
      expect.any(String),
    );

    await agent.close();
  });

  it('Viva 5xx: app boots successfully, warning logged, retry scheduled', async () => {
    const agent = new MockAgent();
    agent.disableNetConnect();
    const pool = agent.get(DEMO_AUTH_HOST);
    // First call returns 503.
    pool.intercept({ path: TOKEN_PATH, method: 'POST' }).reply(503, 'Service Unavailable');

    const { strategy, tokenCache } = buildStrategy(agent);
    const bootstrap = buildBootstrap(makeOptions(), strategy);

    // Should NOT throw — boot-resilient.
    await expect(bootstrap.onApplicationBootstrap()).resolves.toBeUndefined();

    // Token cache should be empty.
    const cached = await tokenCache.get('viva:isv:token:test-id:demo');
    expect(cached).toBeNull();

    // Warmup failed flag set.
    expect(bootstrap.lastWarmupFailed).toBe(true);

    // Warning was logged.
    expect(Logger.warn).toHaveBeenCalledWith(
      expect.stringContaining('Scheduling retry'),
      expect.any(String),
    );

    await agent.close();
  });

  it('Viva 5xx: retry after delay resolves successfully', async () => {
    const agent = new MockAgent();
    agent.disableNetConnect();
    const pool = agent.get(DEMO_AUTH_HOST);
    // First call → 503, retry → 200.
    pool.intercept({ path: TOKEN_PATH, method: 'POST' }).reply(503, 'Service Unavailable');
    pool.intercept({ path: TOKEN_PATH, method: 'POST' }).reply(200, makeTokenBody(), {
      headers: { 'content-type': 'application/json' },
    });

    const { strategy, tokenCache } = buildStrategy(agent);
    const bootstrap = buildBootstrap(makeOptions(), strategy);

    await bootstrap.onApplicationBootstrap();
    expect(bootstrap.lastWarmupFailed).toBe(true);

    // Fast-forward past the retry delay (10_000 ms).
    await vi.runAllTimersAsync();

    // After retry, token should be cached.
    const cached = await tokenCache.get('viva:isv:token:test-id:demo');
    expect(cached).not.toBeNull();
    expect(cached?.access_token).toBe('tok_bootstrap_test');
    expect(bootstrap.lastWarmupFailed).toBe(false);

    await agent.close();
  });

  it('network error (reject): app boots, warning logged, retry scheduled', async () => {
    const agent = new MockAgent();
    agent.disableNetConnect();
    const pool = agent.get(DEMO_AUTH_HOST);
    // Simulate network-level failure.
    pool.intercept({ path: TOKEN_PATH, method: 'POST' }).replyWithError(new Error('ECONNREFUSED'));

    const { strategy, tokenCache } = buildStrategy(agent);
    const bootstrap = buildBootstrap(makeOptions(), strategy);

    await expect(bootstrap.onApplicationBootstrap()).resolves.toBeUndefined();

    const cached = await tokenCache.get('viva:isv:token:test-id:demo');
    expect(cached).toBeNull();
    expect(bootstrap.lastWarmupFailed).toBe(true);
    expect(Logger.warn).toHaveBeenCalledWith(
      expect.stringContaining('Scheduling retry'),
      expect.any(String),
    );

    await agent.close();
  });

  it('retry also fails: logs final warning, token cache stays empty', async () => {
    const agent = new MockAgent();
    agent.disableNetConnect();
    const pool = agent.get(DEMO_AUTH_HOST);
    // Both calls fail.
    pool.intercept({ path: TOKEN_PATH, method: 'POST' }).reply(503, 'Service Unavailable');
    pool.intercept({ path: TOKEN_PATH, method: 'POST' }).reply(503, 'Service Unavailable');

    const { strategy, tokenCache } = buildStrategy(agent);
    const bootstrap = buildBootstrap(makeOptions(), strategy);

    await bootstrap.onApplicationBootstrap();
    await vi.runAllTimersAsync();

    const cached = await tokenCache.get('viva:isv:token:test-id:demo');
    expect(cached).toBeNull();
    expect(bootstrap.lastWarmupFailed).toBe(true);
    // Final warning mentions lazy fetch.
    expect(Logger.warn).toHaveBeenCalledWith(
      expect.stringContaining('lazily fetched'),
      expect.any(String),
    );

    await agent.close();
  });

  it('lazy-fetch fallback: after failed bootstrap, getBearerToken still works on demand', async () => {
    const agent = new MockAgent();
    agent.disableNetConnect();
    const pool = agent.get(DEMO_AUTH_HOST);
    // Bootstrap call → 503.
    pool.intercept({ path: TOKEN_PATH, method: 'POST' }).reply(503, 'Service Unavailable');
    // Lazy call → 200.
    pool.intercept({ path: TOKEN_PATH, method: 'POST' }).reply(200, makeTokenBody(), {
      headers: { 'content-type': 'application/json' },
    });

    const { strategy, tokenCache } = buildStrategy(agent);
    const bootstrap = buildBootstrap(makeOptions(), strategy);

    await bootstrap.onApplicationBootstrap();
    expect(bootstrap.lastWarmupFailed).toBe(true);

    // Simulate createPayment lazy-fetching the token.
    const token = await strategy.getBearerToken();
    expect(token).toBe('tok_bootstrap_test');

    const cached = await tokenCache.get('viva:isv:token:test-id:demo');
    expect(cached?.access_token).toBe('tok_bootstrap_test');

    await agent.close();
  });
});
