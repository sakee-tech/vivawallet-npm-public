#!/usr/bin/env node
/**
 * bin.ts — CLI shim for viva-register-webhooks.
 *
 * Parses CLI flags with node:util.parseArgs (no npm dependency) and
 * delegates to run() from register-webhooks.ts.
 *
 * @see references/viva-docs/md/isv-partner-program.txt:196 (ISV webhook setup)
 * @see references/viva-docs/md/webhooks-for-payments.txt:134 (10-URL limit)
 */

import { parseArgs } from 'node:util';
import { run } from './register-webhooks.js';

const { values } = parseArgs({
  options: {
    'dry-run':          { type: 'boolean', default: false },
    apply:              { type: 'boolean', default: false },
    'webhook-base-url': { type: 'string' },
    'reconcile-drift':  { type: 'boolean', default: false },
    output:             { type: 'string', default: 'human' },
    help:               { type: 'boolean', default: false, short: 'h' },
  },
  strict: true,
});

if (values.help) {
  console.log(`
viva-register-webhooks — Set up V1 webhook URLs for the configured Viva account.

Mode is auto-detected from VIVA_MODE (or VIVA_RESELLER_* presence):
  - ISV mode:      idempotently POSTs to /isv/v1/webhooks for every event type.
  - Merchant mode: prints the URLs to paste into Viva Self Care → Sales →
                   API Access → Webhooks and the verification key.

Usage:
  viva-register-webhooks --dry-run [--output json]
  viva-register-webhooks --apply [--reconcile-drift]
  viva-register-webhooks --apply --webhook-base-url https://api.example.com

Environment:
  VIVA_MODE                     merchant | isv (auto-detected if unset)
  VIVA_ENVIRONMENT              demo | production    (default: demo)
  VIVA_CLIENT_ID                required (alias: VIVA_ISV_CLIENT_ID, deprecated)
  VIVA_CLIENT_SECRET            required (alias: VIVA_ISV_CLIENT_SECRET, deprecated)
  VIVA_MERCHANT_ID              required (Basic-auth username; used in both modes)
  VIVA_API_KEY                  required (Basic-auth password; used in both modes)
  VIVA_WEBHOOK_VERIFICATION_KEY required
  VIVA_WEBHOOK_BASE_URL         required; e.g., https://api.example.com

Notes:
  --reconcile-drift is non-applicable in merchant mode (manual setup only).

Exit codes:
  0  clean / applied successfully / merchant manual setup printed
  1  plan has actions but --apply was not passed (CI gate use case — ISV mode)
  2  apply failed (HTTP/Viva error)
  3  fatal precondition (config invalid, near-limit abort)
`);
  process.exit(0);
}

if (!values['dry-run'] && !values.apply) {
  console.error('Specify --dry-run or --apply (or --help).');
  process.exit(3);
}

const runOpts: Parameters<typeof run>[0] = {
  dryRun: !!values['dry-run'],
  apply: !!values.apply,
  reconcileDrift: !!values['reconcile-drift'],
  output: (values.output as 'human' | 'json') ?? 'human',
};

if (values['webhook-base-url'] !== undefined) {
  runOpts.webhookBaseUrl = values['webhook-base-url'];
}

const exitCode = await run(runOpts);

process.exit(exitCode);
