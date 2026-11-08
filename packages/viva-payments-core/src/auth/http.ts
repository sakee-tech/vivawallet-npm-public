/**
 * Shared undici Pool dispatchers for outbound Viva API calls.
 *
 * Two separate pools are maintained — one per host — because the auth
 * endpoint (`/connect/token`) and the API endpoint live on different hosts.
 * Mixing them in one pool would route all requests to a single origin.
 *
 * @see references/viva-docs/md/oauth2-authentication.txt:145 (environment URLs)
 * @see references/viva-docs/md/oauth2-authentication.txt:145 (demo vs production hosts)
 */

import { Pool, type Dispatcher } from 'undici';
import { ENVIRONMENT_URLS } from '../types/common.js';
import type { VivaEnvironment } from '../types/common.js';

// Re-export VivaEnvironment for consumers that import solely from auth/http.
export type { VivaEnvironment };

export interface VivaHttpConfig {
  /** 'demo' | 'production' */
  environment: VivaEnvironment;
  /** Optional dispatcher override — use in unit tests with MockAgent. */
  dispatcher?: Dispatcher;
}

/**
 * Pool connection settings shared across auth and API dispatchers.
 * Keep-alive is enabled with a 30 s idle timeout and a 10-minute max.
 * Pipelining is deliberately set to 1 (safe default for HTTP/1.1 APIs).
 */
const POOL_OPTIONS: ConstructorParameters<typeof Pool>[1] = {
  connections: 8,
  keepAliveTimeout: 30_000,
  keepAliveMaxTimeout: 600_000,
  pipelining: 1,
  bodyTimeout: 30_000,
  headersTimeout: 30_000,
};

/** Lazily created, memoized per-host pools. */
const authPools = new Map<VivaEnvironment, Pool>();
const apiPools = new Map<VivaEnvironment, Pool>();

/**
 * Returns a memoized undici Pool for the auth host (`/connect/token`).
 *
 * @see references/viva-docs/md/oauth2-authentication.txt:145
 * Demo:       https://demo-accounts.vivapayments.com
 * Production: https://accounts.vivapayments.com
 */
export function getAuthDispatcher(env: VivaEnvironment): Dispatcher {
  let pool = authPools.get(env);
  if (!pool) {
    const { authBaseUrl } = ENVIRONMENT_URLS[env];
    pool = new Pool(authBaseUrl, POOL_OPTIONS);
    authPools.set(env, pool);
  }
  return pool;
}

/**
 * Returns a memoized undici Pool for the Viva API host.
 *
 * @see references/viva-docs/md/oauth2-authentication.txt:145
 * Demo:       https://demo-api.vivapayments.com
 * Production: https://api.vivapayments.com
 */
export function getApiDispatcher(env: VivaEnvironment): Dispatcher {
  let pool = apiPools.get(env);
  if (!pool) {
    const { apiBaseUrl } = ENVIRONMENT_URLS[env];
    pool = new Pool(apiBaseUrl, POOL_OPTIONS);
    apiPools.set(env, pool);
  }
  return pool;
}

/**
 * Closes all memoized pools. Call this in test `afterAll` hooks and during
 * graceful process shutdown to avoid open-handle warnings.
 *
 * Note: dispatchers are process-shared; tests MUST call `closeAllDispatchers()`
 * in `afterAll` when injecting a `MockAgent` to avoid cross-test leaks.
 */
export async function closeAllDispatchers(): Promise<void> {
  const closers: Promise<void>[] = [];
  for (const pool of authPools.values()) {
    closers.push(pool.close());
  }
  for (const pool of apiPools.values()) {
    closers.push(pool.close());
  }
  authPools.clear();
  apiPools.clear();
  await Promise.all(closers);
}
