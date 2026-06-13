/**
 * LIVE — OAuth2 token minting against the Viva demo accounts host.
 *
 * Read-only: minting a client_credentials token has no side effects, so these
 * run on any default live invocation where the creds are present.
 */

import { it, expect } from 'vitest';
import { liveDescribe, ISV_OAUTH_VARS, SINGLE_OAUTH_VARS } from './_env.js';
import { makeIsvOAuthStrategy, makeSingleOAuthStrategy } from './_clients.js';

liveDescribe('LIVE auth — ISV OAuth2', ISV_OAUTH_VARS, () => {
  it('mints a bearer token', async () => {
    const strategy = makeIsvOAuthStrategy();
    const token = await strategy.getBearerToken();
    expect(typeof token).toBe('string');
    expect(token.length).toBeGreaterThan(20);
  });

  it('returns a cached token on the second call (no forceRefresh)', async () => {
    const strategy = makeIsvOAuthStrategy();
    const first = await strategy.getBearerToken();
    const second = await strategy.getBearerToken();
    expect(second).toBe(first);
  });

  it('mints a fresh token on forceRefresh', async () => {
    const strategy = makeIsvOAuthStrategy();
    await strategy.getBearerToken();
    const refreshed = await strategy.getBearerToken({ forceRefresh: true });
    expect(typeof refreshed).toBe('string');
    expect(refreshed.length).toBeGreaterThan(20);
  });
});

liveDescribe('LIVE auth — single-merchant OAuth2', SINGLE_OAUTH_VARS, () => {
  it('mints a bearer token', async () => {
    const strategy = makeSingleOAuthStrategy();
    const token = await strategy.getBearerToken();
    expect(typeof token).toBe('string');
    expect(token.length).toBeGreaterThan(20);
  });
});
