/**
 * fixtures-loader.ts — Load sandbox fixture JSON files for tests.
 *
 * All fixtures live under test/sandbox/fixtures/ and are static JSON files
 * representing recorded Viva demo API responses and webhook envelopes.
 *
 * Usage:
 *   import { loadFixture } from '../fixtures-loader.js';
 *   const token = loadFixture<OAuthTokenResponse>('isv', 'oauth-token-success');
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
