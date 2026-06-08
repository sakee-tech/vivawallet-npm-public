/**
 * fixtures-loader.ts — Load sandbox fixture JSON files for tests.
 *
 * All fixtures live under test/sandbox/fixtures/ and are static JSON files
 * representing recorded Viva demo API responses and webhook envelopes.
 *
 * Usage:
 *   import { loadFixture, loadHmacFixture } from '../fixtures-loader.js';
 *   const token = loadFixture<OAuthTokenResponse>('isv', 'oauth-token-success');
 *   const hmac  = loadHmacFixture('envelope-7936-sale-transactions-with-hmac');
 *
 * No live HTTP — all responses are pre-recorded static JSON. See fixtures/README.md
 * for how to refresh fixtures against the Viva demo environment.
 *
 * @see packages/viva-payments-core/test/sandbox/fixtures/README.md
 */

import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type FixtureCategory = 'isv' | 'webhooks';

export interface HmacFixture {
  /** Raw JSON body string that was HMAC-signed (exactly as it would arrive on the wire). */
  rawBody: string;
  /** Pre-computed HMAC-SHA256 hex digest of rawBody using testSecret. */
  signatureHex: string;
  /** The HMAC secret used (documented in fixture _meta). */
  secret: string;
  /** Parsed envelope object. */
  envelope: unknown;
}

// ---------------------------------------------------------------------------
// Internal cache
// ---------------------------------------------------------------------------

/** Process-level cache to avoid re-reading the same file on every test. */
const _cache = new Map<string, unknown>();

const _fixturesDir = resolve(dirname(fileURLToPath(import.meta.url)), 'fixtures');

// ---------------------------------------------------------------------------
// loadFixture
// ---------------------------------------------------------------------------

/**
 * Load a fixture JSON file from `test/sandbox/fixtures/{category}/{name}.json`.
 *
 * Returns the parsed JSON as `T`. The `_meta` block is included in the returned
 * object (strip it yourself if you need a clean wire shape).
 *
 * Throws with a descriptive error if the file does not exist.
 *
 * @param category - 'isv' or 'webhooks'
 * @param name     - filename without the `.json` extension
 *
 * @example
 * const token = loadFixture<{ access_token: string }>('isv', 'oauth-token-success');
 * console.log(token.access_token); // "eyJ..."
 */
export function loadFixture<T = unknown>(category: FixtureCategory, name: string): T {
  const cacheKey = `${category}/${name}`;
  if (_cache.has(cacheKey)) {
    return _cache.get(cacheKey) as T;
  }

  const filePath = resolve(_fixturesDir, category, `${name}.json`);
  let raw: string;
  try {
    raw = readFileSync(filePath, 'utf-8');
  } catch (err) {
    throw new Error(
      `[fixtures-loader] Fixture not found: ${filePath}\n` +
        `  category="${category}" name="${name}"\n` +
        `  Check fixtures/README.md for how to add or refresh fixtures.\n` +
        `  Underlying error: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(
      `[fixtures-loader] Failed to parse fixture JSON: ${filePath}\n` +
        `  Error: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  _cache.set(cacheKey, parsed);
  return parsed as T;
}

// ---------------------------------------------------------------------------
// loadHmacFixture
// ---------------------------------------------------------------------------

/**
 * Load the HMAC fixture for event type 7936 (Sale Transactions).
 *
 * Returns:
 *   - `rawBody`      — the exact JSON string that was HMAC-signed
 *   - `signatureHex` — pre-computed hex digest
 *   - `secret`       — the HMAC secret used (always 'test-secret' in fixtures)
 *   - `envelope`     — parsed envelope object
 *
 * At test time, verify with:
 * ```ts
 * import { createHmac } from 'node:crypto';
 * const computed = createHmac('sha256', hmac.secret).update(hmac.rawBody).digest('hex');
 * expect(computed).toBe(hmac.signatureHex);
 * ```
 *
 * @param name - filename without `.json` extension (default: 'envelope-7936-sale-transactions-with-hmac')
 */
export function loadHmacFixture(
  name = 'envelope-7936-sale-transactions-with-hmac',
): HmacFixture {
  const data = loadFixture<{
    rawBody: string;
    signatureHex: string;
    testSecret: string;
    envelope: unknown;
    _meta: unknown;
  }>('webhooks', name);

  if (
    typeof data.rawBody !== 'string' ||
    typeof data.signatureHex !== 'string' ||
    typeof data.testSecret !== 'string'
  ) {
    throw new Error(
      `[fixtures-loader] HMAC fixture '${name}' is missing required fields: ` +
        `rawBody (string), signatureHex (string), testSecret (string).`,
    );
  }

  return {
    rawBody: data.rawBody,
    signatureHex: data.signatureHex,
    secret: data.testSecret,
    envelope: data.envelope,
  };
}
