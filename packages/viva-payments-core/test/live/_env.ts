/**
 * Shared env helpers for the LIVE suite.
 *
 * Reads credentials from `process.env` (populated by `_setup.ts` from the
 * repo-root `.env`). Never logs or echoes a secret value. Tests use
 * `liveDescribe(...)` so a suite SELF-SKIPS when its required vars are absent,
 * rather than failing — a developer with only the ISV creds set still gets a
 * green run with the merchant-only suites skipped.
 */

import { describe } from 'vitest';

export const ENVIRONMENT = (process.env['VIVA_ENVIRONMENT'] ?? 'demo') as
  | 'demo'
  | 'production';

/** Mutating live calls (createOrder, create account/source, register webhook)
 *  only run when this is set — keeps default runs from polluting the demo
 *  account with new server-side state on every invocation. */
export const MUTATIONS_ENABLED = process.env['VIVA_LIVE_MUTATIONS'] === '1';

/** Card-seeded (Playwright) suites need a real browser-driven payment; gated
 *  separately so they stay skipped until Playwright is installed + opted in. */
export const CARD_ENABLED = process.env['VIVA_LIVE_CARD'] === '1';

/**
 * Persistent demo identities recorded across probe sessions
 * (docs/resume/2026-05-12-evening.md). Overridable via env. These are the
 * VERIFIED ISV connected account + its merchantId, safe to retrieve and to
 * create orders against.
 */
export const DEMO_ISV_ACCOUNT_ID =
  process.env['VIVA_ISV_ACCOUNT_ID'] || '74d21978-85da-4606-8e36-b9c575eefa9e';
export const DEMO_ISV_MERCHANT_ID =
  process.env['VIVA_ISV_MERCHANT_ID'] || '5cf789ee-6b1b-46ab-a71f-03ffdb912c9a';

export function getEnv(name: string): string | undefined {
  const v = process.env[name];
  return v === undefined || v === '' ? undefined : v;
}

/** Throw if absent — use inside a `liveDescribe` body where presence is
 *  already guaranteed, to satisfy the type-checker and narrow to string. */
export function requireEnv(name: string): string {
  const v = getEnv(name);
  if (v === undefined) throw new Error(`missing required env var ${name}`);
  return v;
}

export function hasAll(...names: string[]): boolean {
  return names.every((n) => getEnv(n) !== undefined);
}

/**
 * `describe` that self-skips when any required env var is missing. The skip
 * reason names the missing vars (names only — never values) so a skipped run
 * tells you exactly which credentials to add.
 */
export function liveDescribe(
  name: string,
  requiredVars: string[],
  fn: () => void,
): void {
  const missing = requiredVars.filter((n) => getEnv(n) === undefined);
  if (missing.length > 0) {
    describe.skip(`${name} [skipped: missing ${missing.join(', ')}]`, fn);
  } else {
    describe(name, fn);
  }
}

// Credential group names, grouped by the identity they belong to. Kept as
// arrays so test files can pass them straight to liveDescribe / hasAll.
export const ISV_OAUTH_VARS = ['VIVA_ISV_CLIENT_ID', 'VIVA_ISV_CLIENT_SECRET'];
export const ISV_RESELLER_VARS = [
  'VIVA_ISV_RESELLER_ID',
  'VIVA_ISV_MERCHANT_ID',
  'VIVA_ISV_RESELLER_API_KEY',
];
export const SINGLE_OAUTH_VARS = [
  'VIVA_SINGLE_OAUTH_CLIENT_ID',
  'VIVA_SINGLE_OAUTH_CLIENT_SECRET',
];
export const SINGLE_MERCHANT_BASIC_VARS = [
  'VIVA_SINGLE_MERCHANT_ID',
  'VIVA_SINGLE_MERCHANT_API_KEY',
];
