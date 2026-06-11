#!/usr/bin/env node
/**
 * bin.ts — CLI entrypoint for vendure-viva-register-webhooks.
 *
 * Parses argv with node:util.parseArgs (zero additional npm dependencies).
 * Loads plugin config from env vars and delegates to run() from register-webhooks.ts.
 *
 * Env vars:
 *   VIVA_MODE                     merchant | isv (default: merchant)
 *   VIVA_CLIENT_ID                required (ISV mode) — alias VIVA_ISV_CLIENT_ID deprecated
 *   VIVA_CLIENT_SECRET            required (ISV mode) — alias VIVA_ISV_CLIENT_SECRET deprecated
 *   VIVA_MERCHANT_ID              required (merchant --apply)
 *   VIVA_API_KEY                  required (merchant --apply)
 *   VIVA_ENVIRONMENT              demo | production (default: demo)
 *   VIVA_WEBHOOK_URL              required for registration (full URL)
 *   VIVA_WEBHOOK_VERIFICATION_KEY required; must equal the Viva-issued ISV key
 *
 * Verification key note:
 *   In ISV mode the CLI fetches the Viva-issued key via GET /isv/v1/webhooks/token
 *   and reconciles it against VIVA_WEBHOOK_VERIFICATION_KEY. If the env var is unset
 *   or doesn't match, the CLI aborts and prints the correct value to set — it does
 *   NOT invent a key. Set the value in your plugin options and env so the
 *   GET /viva/webhook endpoint echoes it during Viva's URL-verify handshake.
 *   The key is NOT posted to Viva — Viva fetches it from your endpoint.
 *
 * @see docs/plans/vendure-plugin-v0.md §"CLI vendure-viva-register-webhooks" (V10)
 * @see src/api/webhook.controller.ts (handleVerification)
 */

import { parseArgs } from 'node:util';
import { run } from './register-webhooks.js';
import type { RunOptions } from './types.js';

const { values } = parseArgs({
  options: {
    'dry-run':      { type: 'boolean', default: false },
    apply:          { type: 'boolean', default: false },
    'webhook-url':  { type: 'string' },
    'reconcile-drift': { type: 'boolean', default: false },
    output:         { type: 'string', default: 'text' },
    help:           { type: 'boolean', default: false, short: 'h' },
  },
  strict: true,
});

if (values.help) {
  console.log(`
vendure-viva-register-webhooks — Set up V1 webhook URLs for the configured Viva account.

Mode is selected by VIVA_MODE (default: merchant; auto-isv if VIVA_RESELLER_* set):
  - ISV mode:      idempotently POSTs to /isv/v1/webhooks for every event type
                   (1796, 1797, 1798, 4865, 8193, 8194).
  - Merchant mode: prints the four transaction-event URLs (1796/1797/1798/4865)
                   to register manually in Viva Self Care → Sales → API Access
                   → Webhooks, plus the verification key fetched via
                   GET /api/messages/config/token.

Usage:
  vendure-viva-register-webhooks --dry-run [--output json]
  vendure-viva-register-webhooks --apply [--reconcile-drift]
  vendure-viva-register-webhooks --apply --webhook-url https://api.example.com/viva/webhook

Environment:
  VIVA_MODE                     merchant | isv (default: merchant)
  VIVA_ENVIRONMENT              demo | production    (default: demo)
  VIVA_CLIENT_ID                required for ISV mode (alias: VIVA_ISV_CLIENT_ID, deprecated)
  VIVA_CLIENT_SECRET            required for ISV mode (alias: VIVA_ISV_CLIENT_SECRET, deprecated)
  VIVA_MERCHANT_ID              required for merchant --apply (legacy Basic-auth)
  VIVA_API_KEY                  required for merchant --apply (legacy Basic-auth)
  VIVA_WEBHOOK_URL              required; full URL to receive webhook POSTs
  VIVA_WEBHOOK_VERIFICATION_KEY required; must equal the Viva-issued ISV key

Notes:
  --reconcile-drift is non-applicable in merchant mode (manual setup only).

Verification key:
  - ISV mode: the CLI fetches the Viva-issued key via GET /isv/v1/webhooks/token
    and reconciles it against VIVA_WEBHOOK_VERIFICATION_KEY. If the env var is
    unset or doesn't match, the CLI aborts (exit 3) and prints the correct value
    to set in your VivaPaymentPlugin.init() options AND .env. It never invents a
    key. Viva sends a GET probe to your webhook URL during registration; the
    WebhookController must return {"key":"<the-issued-key>"} to prove ownership.
  - Merchant mode: the CLI fetches the key via GET /api/messages/config/token
    on the legacy host. Paste the printed value into the same env var.

Exit codes:
  0  clean / applied successfully / merchant manual setup printed
  1  plan has actions but --apply was not passed (CI gate use case — ISV mode)
  2  apply failed (HTTP/Viva error, incl. verification-key fetch)
  3  fatal precondition (config invalid, ABORT_LIMIT_HIT, key unset/mismatch)
`);
  process.exit(0);
}

if (!values['dry-run'] && !values.apply) {
  console.error('Specify --dry-run or --apply (or --help).');
  process.exit(3);
}

const outputValue = values.output as string;
const output: RunOptions['output'] = outputValue === 'json' ? 'json' : 'text';

const runOpts: RunOptions = {
  dryRun: !!values['dry-run'],
  apply: !!values.apply,
  reconcileDrift: !!values['reconcile-drift'],
  output,
};

if (values['webhook-url'] !== undefined) {
  runOpts.webhookUrl = values['webhook-url'];
}

void (async () => {
  const exitCode = await run(runOpts);
  process.exit(exitCode);
})();
