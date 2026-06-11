/**
 * OAuth2ClientCredentialsStrategy tests.
 *
 * All HTTP is intercepted by undici MockAgent — no live network calls.
 *
 * @see references/viva-docs/md/oauth2-authentication.txt:145 (token endpoints)
 * @see references/viva-docs/md/oauth2-authentication.txt:179 (response shape)
 * @see references/viva-docs/md/oauth2-authentication.txt:192 (expires_in = 3600)
 */

import { describe, it, expect, afterEach, vi } from 'vitest';
import { MockAgent, setGlobalDispatcher, getGlobalDispatcher } from 'undici';
import type { Dispatcher } from 'undici';
import { OAuth2ClientCredentialsStrategy } from '../../src/auth/oauth2-strategy.js';
import { InMemoryTokenCache } from '../../src/auth/token-cache.js';
import { AsyncMutex } from '../../src/auth/single-flight.js';
import { VivaAuthError } from '../../src/errors/auth-error.js';
import { VivaRateLimitError } from '../../src/errors/rate-limit-error.js';
import { VivaApiError } from '../../src/errors/api-error.js';

// Demo auth host as per docs line 145
const AUTH_HOST = 'https://demo-accounts.vivapayments.com';
const TOKEN_PATH = '/connect/token';

function makeTokenBody(overrides?: Partial<{
  access_token: string;
  expires_in: number;
  token_type: string;
  scope: string;
}>) {
  return {
    access_token: 'tok_test_access',
    expires_in: 3600,
    token_type: 'Bearer',
    scope: 'urn:viva:payments:core',
    ...overrides,
  };
}

/** Build a strategy with a fresh MockAgent wired as dispatcher. */
function buildStrategy(opts?: {
  agent?: MockAgent;
  cache?: InMemoryTokenCache;
  mutex?: AsyncMutex;
  now?: () => number;
}) {
  const agent = opts?.agent ?? new MockAgent();
  agent.disableNetConnect();
  const pool = agent.get(AUTH_HOST);

  // Build a fetch impl that uses the MockAgent dispatcher
  const fetchImpl = (url: RequestInfo | URL, init?: RequestInit) => {
    return fetch(url, {
      ...init,
      // @ts-expect-error undici dispatcher option
      dispatcher: agent,
    });
  };

  const strategy = new OAuth2ClientCredentialsStrategy({
    environment: 'demo',
    clientId: 'test_client_id',
    clientSecret: 'test_client_secret',
    cache: opts?.cache ?? new InMemoryTokenCache({ now: opts?.now }),
    mutex: opts?.mutex ?? new AsyncMutex(),
    fetchImpl,
    dispatcher: agent as unknown as Dispatcher,
    now: opts?.now,
  });

  return { strategy, agent, pool };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('OAuth2ClientCredentialsStrategy', () => {
  it('happy path: first call POSTs to /connect/token and returns access_token', async () => {
    const { strategy, agent, pool } = buildStrategy();

    pool
      .intercept({ path: TOKEN_PATH, method: 'POST' })
      .reply(200, JSON.stringify(makeTokenBody()), {
        headers: { 'Content-Type': 'application/json' },
      });

    const token = await strategy.getBearerToken();
    expect(token).toBe('tok_test_access');

    agent.assertNoPendingInterceptors();
    await agent.close();
  });

  it('second call within window returns cached value — exactly 1 HTTP request', async () => {
    const { strategy, agent, pool } = buildStrategy();

    // Only intercept once — a second HTTP call would throw "no interceptor"
    pool
      .intercept({ path: TOKEN_PATH, method: 'POST' })
      .reply(200, JSON.stringify(makeTokenBody()), {
        headers: { 'Content-Type': 'application/json' },
      });

    const t1 = await strategy.getBearerToken();
    const t2 = await strategy.getBearerToken();

    expect(t1).toBe('tok_test_access');
    expect(t2).toBe('tok_test_access');

    agent.assertNoPendingInterceptors();
    await agent.close();
  });

  it('100 concurrent getBearerToken() produce exactly 1 request', async () => {
    const mutex = new AsyncMutex();
    const cache = new InMemoryTokenCache();
    const { strategy, agent, pool } = buildStrategy({ mutex, cache });

    // One interceptor — second request would throw
    pool
      .intercept({ path: TOKEN_PATH, method: 'POST' })
      .reply(200, JSON.stringify(makeTokenBody()), {
        headers: { 'Content-Type': 'application/json' },
      });

    const results = await Promise.all(
      Array.from({ length: 100 }, () => strategy.getBearerToken()),
    );

    expect(results).toHaveLength(100);
    expect(results.every((t) => t === 'tok_test_access')).toBe(true);

    agent.assertNoPendingInterceptors();
    await agent.close();
  });

  it('token near expiry triggers refresh (within refreshSkewMs)', async () => {
    let now = 1_000_000_000;
    const cache = new InMemoryTokenCache({ now: () => now });
    const { strategy, agent, pool } = buildStrategy({ cache, now: () => now });

    // First fetch
    pool
      .intercept({ path: TOKEN_PATH, method: 'POST' })
      .reply(200, JSON.stringify(makeTokenBody()), {
        headers: { 'Content-Type': 'application/json' },
      });
    await strategy.getBearerToken();

    // Advance time to 4 minutes before expiry (default refreshSkewMs = 5 min)
    // expires_at = now_at_fetch + 3600*1000 - 60_000 = now_at_fetch + 3_540_000
    // We need expires_at <= now + 5*60_000 = now + 300_000
    // So: now_at_fetch + 3_540_000 <= now + 300_000
    //     now >= now_at_fetch + 3_240_000
    now += 3_240_001;

    // Second interceptor for the refresh
    pool
      .intercept({ path: TOKEN_PATH, method: 'POST' })
      .reply(200, JSON.stringify(makeTokenBody({ access_token: 'tok_refreshed' })), {
        headers: { 'Content-Type': 'application/json' },
      });

    const refreshed = await strategy.getBearerToken();
    expect(refreshed).toBe('tok_refreshed');

    agent.assertNoPendingInterceptors();
    await agent.close();
  });

  it('forceRefresh=true makes a second HTTP request; both go through the lock', async () => {
    const mutex = new AsyncMutex();
    const acquireSpy = vi.spyOn(mutex, 'acquire');
    const cache = new InMemoryTokenCache();

    const { strategy, agent, pool } = buildStrategy({ mutex, cache });

    pool
      .intercept({ path: TOKEN_PATH, method: 'POST' })
      .reply(200, JSON.stringify(makeTokenBody()), {
        headers: { 'Content-Type': 'application/json' },
      });
    pool
      .intercept({ path: TOKEN_PATH, method: 'POST' })
      .reply(200, JSON.stringify(makeTokenBody({ access_token: 'tok_forced' })), {
        headers: { 'Content-Type': 'application/json' },
      });

    await strategy.getBearerToken();
    const forced = await strategy.getBearerToken({ forceRefresh: true });

    expect(forced).toBe('tok_forced');
    // Both calls acquired the mutex (acquireSpy called 2x)
    expect(acquireSpy).toHaveBeenCalledTimes(2);

    agent.assertNoPendingInterceptors();
    await agent.close();
  });

  it('401 response throws VivaAuthError with requestId from CorrelationId header', async () => {
    const { strategy, agent, pool } = buildStrategy();

    pool
      .intercept({ path: TOKEN_PATH, method: 'POST' })
      .reply(401, '{"error":"invalid_client"}', {
        headers: {
          'Content-Type': 'application/json',
          CorrelationId: 'corr-abc-123',
        },
      });

    await expect(strategy.getBearerToken()).rejects.toSatisfy((err: unknown) => {
      expect(err).toBeInstanceOf(VivaAuthError);
      expect((err as VivaAuthError).code).toBe('VIVA_AUTH_ERROR');
      expect((err as VivaAuthError).httpStatus).toBe(401);
      expect((err as VivaAuthError).requestId).toBe('corr-abc-123');
      return true;
    });

    await agent.close();
  });

  it('403 response throws VivaAuthError', async () => {
    const { strategy, agent, pool } = buildStrategy();

    pool
      .intercept({ path: TOKEN_PATH, method: 'POST' })
      .reply(403, '{"error":"forbidden"}', {
        headers: { 'Content-Type': 'application/json' },
      });

    await expect(strategy.getBearerToken()).rejects.toBeInstanceOf(VivaAuthError);
    await agent.close();
  });

  it('429 response with Retry-After: 5 throws VivaRateLimitError with retryAfterMs=5000', async () => {
    const { strategy, agent, pool } = buildStrategy();

    pool
      .intercept({ path: TOKEN_PATH, method: 'POST' })
      .reply(429, '{"error":"rate_limited"}', {
        headers: {
          'Content-Type': 'application/json',
          'Retry-After': '5',
        },
      });

    await expect(strategy.getBearerToken()).rejects.toSatisfy((err: unknown) => {
      expect(err).toBeInstanceOf(VivaRateLimitError);
      expect((err as VivaRateLimitError).code).toBe('VIVA_RATE_LIMIT_ERROR');
      expect((err as VivaRateLimitError).httpStatus).toBe(429);
      expect((err as VivaRateLimitError).retryAfterMs).toBe(5000);
      expect((err as VivaRateLimitError).retriable).toBe(true);
      return true;
    });

    await agent.close();
  });

  it('5xx response throws VivaRateLimitError (retriable)', async () => {
    const { strategy, agent, pool } = buildStrategy();

    pool
      .intercept({ path: TOKEN_PATH, method: 'POST' })
      .reply(503, 'Service Unavailable', {
        headers: { 'Content-Type': 'text/plain' },
      });

    await expect(strategy.getBearerToken()).rejects.toBeInstanceOf(VivaRateLimitError);
    await agent.close();
  });

  it('AbortError on 30s+ slow response throws VivaApiError wrapping the abort', async () => {
    const agent = new MockAgent();
    agent.disableNetConnect();
    const pool = agent.get(AUTH_HOST);

    // Simulate a slow response: delay longer than the 30s timeout.
    // We shorten the test by injecting a custom fetchImpl that always aborts.
    const abortError = new DOMException('The operation was aborted.', 'AbortError');
    const fetchImpl = (_url: RequestInfo | URL, _init?: RequestInit): Promise<Response> => {
      return Promise.reject(abortError);
    };

    const strategy = new OAuth2ClientCredentialsStrategy({
      environment: 'demo',
      clientId: 'test_client_id',
      clientSecret: 'test_client_secret',
      fetchImpl,
      dispatcher: agent as unknown as Dispatcher,
    });

    await expect(strategy.getBearerToken()).rejects.toSatisfy((err: unknown) => {
      expect(err).toBeInstanceOf(VivaApiError);
      expect((err as VivaApiError).code).toBe('VIVA_API_ERROR');
      expect((err as VivaApiError).cause).toBe(abortError);
      return true;
    });

    await agent.close();
  });
});
