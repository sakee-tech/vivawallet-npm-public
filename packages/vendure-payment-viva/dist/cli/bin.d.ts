#!/usr/bin/env tsx
/**
 * bin.ts — CLI entrypoint for vendure-viva-register-webhooks.
 *
 * Parses argv with node:util.parseArgs (zero additional npm dependencies).
 * Loads plugin config from env vars and delegates to run() from register-webhooks.ts.
 *
 * Env vars:
 *   VIVA_MODE                     merchant | isv (default: isv)
 *   VIVA_CLIENT_ID                required (ISV mode) — alias VIVA_ISV_CLIENT_ID deprecated
 *   VIVA_CLIENT_SECRET            required (ISV mode) — alias VIVA_ISV_CLIENT_SECRET deprecated
 *   VIVA_MERCHANT_ID              required (merchant --apply)
 *   VIVA_API_KEY                  required (merchant --apply)
 *   VIVA_ENVIRONMENT              demo | production (default: demo)
 *   VIVA_WEBHOOK_URL              required for registration (full URL)
 *   VIVA_WEBHOOK_VERIFICATION_KEY optional in ISV mode; generated if absent
 *
 * Verification key note:
 *   If VIVA_WEBHOOK_VERIFICATION_KEY is not set, the CLI generates a UUIDv4 and
 *   prints it. You must set this value in your plugin options and env before Viva
 *   can probe the GET /viva/webhook endpoint for URL verification.
 *   The key is NOT posted to Viva — Viva fetches it from your endpoint.
 *
 * @see docs/plans/vendure-plugin-v0.md §"CLI vendure-viva-register-webhooks" (V10)
 * @see src/api/webhook.controller.ts (handleVerification)
 */
export {};
//# sourceMappingURL=bin.d.ts.map