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
export {};
//# sourceMappingURL=bin.d.ts.map