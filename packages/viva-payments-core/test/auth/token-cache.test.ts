import { describe, it, expect } from 'vitest';
import { InMemoryTokenCache } from '../../src/auth/token-cache.js';
import type { CachedToken } from '../../src/types/auth.js';

const makeToken = (expiresAtOffset: number, now: number): CachedToken => ({
  access_token: 'tok_abc',
  expires_at: now + expiresAtOffset,
  scope: 'payments',
});

describe('InMemoryTokenCache', () => {
  it('get/set/delete round trip', async () => {
    const cache = new InMemoryTokenCache();
    const token = makeToken(60_000, Date.now());
    await cache.set('key1', token);
    const hit = await cache.get('key1');
    expect(hit).toEqual(token);
    await cache.delete('key1');
    expect(await cache.get('key1')).toBeNull();
  });

  it('returns null for missing key', async () => {
    const cache = new InMemoryTokenCache();
    expect(await cache.get('no-such-key')).toBeNull();
  });

  it('returns null after expiry', async () => {
    let now = 1_000_000;
    const cache = new InMemoryTokenCache({ now: () => now });

    // Token expires 1 second from "now"
    const token = makeToken(1_000, now);
    await cache.set('expiry-key', token);

    // Still valid
    expect(await cache.get('expiry-key')).not.toBeNull();

    // Advance time past expiry
    now += 2_000;
    expect(await cache.get('expiry-key')).toBeNull();
  });

  it('token at exact expiry boundary is treated as expired', async () => {
    let now = 1_000_000;
    const cache = new InMemoryTokenCache({ now: () => now });
    const token = makeToken(0, now); // expires_at === now
    await cache.set('boundary', token);
    expect(await cache.get('boundary')).toBeNull();
  });

  it('overwrite replaces the stored value', async () => {
    const cache = new InMemoryTokenCache();
    const t1 = makeToken(60_000, Date.now());
    const t2 = { ...t1, access_token: 'tok_new' };
    await cache.set('k', t1);
    await cache.set('k', t2);
    const result = await cache.get('k');
    expect(result?.access_token).toBe('tok_new');
  });
});
