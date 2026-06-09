/**
 * cli/register-webhooks.ts — Main CLI logic for idempotent webhook registration.
 *
 * Mode-aware:
 *   - ISV mode: builds the ISV webhook client and POSTs one /isv/v1/webhooks
 *     registration per V1 event type (1796, 1797, 1798, 4865, 8193, 8194).
 *     All merchants on the platform share the same webhook URL.
 *   - Merchant mode: Viva offers no programmatic registration. The CLI fetches
 *     the verification key from GET /api/messages/config/token (Basic auth,
 *     merchant variant) and prints the URLs the operator must paste into Viva
 *     Self Care → Sales → API Access → Webhooks. `--reconcile-drift` is
 *     non-applicable in merchant mode.
 *
 * Verification key (ISV mode):
 *   CLI generates a UUIDv4 if VIVA_WEBHOOK_VERIFICATION_KEY is not set.
 *   The key is surfaced for the operator to paste into plugin options + Viva Self Care.
 *   It is NOT posted to Viva — Viva sends a GET probe to /viva/webhook and the
 *   WebhookController returns {"key":"<that-uuid>"} from plugin config.
 *   @see src/api/webhook.controller.ts#handleVerification
 *
 * Exit codes:
 *   0 — clean (no actions OR all applied successfully OR merchant manual setup printed)
 *   1 — plan has actions but --apply was not passed (CI gate use case — ISV mode only)
 *   2 — apply failed (HTTP/Viva error)
 *   3 — fatal precondition (config invalid, ABORT_LIMIT_HIT)
 *
 * Mirrors medusa-payment-viva/src/cli/register-webhooks.ts conventions.
 *
 * @see docs/plans/vendure-plugin-v0.md §"CLI vendure-viva-register-webhooks" (V10)
 * @see references/viva-docs/md/webhooks-for-payments.txt:134 (10-URL limit)
 * @see docs/plans/multi-mode-v0.md §9.5 (CLI behaviour matrix)
 */
type Dispatcher = any;
import type { RunOptions } from './types.js';
export type { RunOptions };
/**
 * Programmatic entry — also called by bin.ts for the CLI.
 * Reads VIVA_* env from the provided env object (defaults to process.env).
 *
 * @param opts       - CLI run options.
 * @param env        - Optional env override (defaults to process.env). Used in tests.
 * @param dispatcher - Optional undici Dispatcher override (MockAgent in tests).
 */
export declare function run(opts: RunOptions, env?: NodeJS.ProcessEnv, dispatcher?: Dispatcher): Promise<number>;
//# sourceMappingURL=register-webhooks.d.ts.map