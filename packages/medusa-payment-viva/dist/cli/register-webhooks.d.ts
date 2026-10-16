/**
 * register-webhooks.ts — CLI entry point for idempotent webhook registration.
 *
 * Mode-aware:
 *   - ISV mode: builds the ISV webhook client and POSTs one /isv/v1/webhooks
 *     registration per V1 event type (existing behaviour, unchanged).
 *   - Merchant mode: Viva offers no programmatic registration. The CLI fetches
 *     the verification key from GET /api/messages/config/token (Basic auth,
 *     merchant variant) and prints the URLs the operator must paste into Viva
 *     Self Care → Sales → API Access → Webhooks. `--reconcile-drift` is
 *     non-applicable in merchant mode.
 *
 * Design: deploy-time orchestrated, not runtime self-registration (plan P12).
 * Re-running after a successful apply produces all SKIP_ALREADY_REGISTERED
 * actions, proving idempotency.
 *
 * Exit codes:
 *   0 — clean (no actions OR all applied successfully OR merchant manual setup printed)
 *   1 — plan has actions but --apply was not passed (CI gate use case — ISV mode only)
 *   2 — apply failed (HTTP error, 4xx/5xx from Viva)
 *   3 — fatal precondition (config invalid, ABORT_LIMIT_HIT, missing webhook URL)
 *
 * @see references/viva-docs/md/webhooks-for-payments.txt:134 (10-URL limit)
 * @see references/viva-docs/md/isv-partner-program.txt:196 (ISV webhook setup)
 * @see docs/ENDPOINTS.md §8.1 (merchant verification-key endpoint)
 * @see docs/plans/multi-mode-v0.md §9.5 (CLI behaviour matrix)
 */
type Dispatcher = any;
export interface RunOptions {
    /** Print the plan and exit; do NOT mutate. */
    dryRun: boolean;
    /** Apply REGISTER + DEACTIVATE_DRIFT actions. */
    apply: boolean;
    /**
     * Override target webhook URL; default is built from env (VIVA_WEBHOOK_BASE_URL).
     * Must be provided here or via VIVA_WEBHOOK_BASE_URL env var.
     */
    webhookBaseUrl?: string | undefined;
    /** When true, run drift reconciliation. */
    reconcileDrift?: boolean | undefined;
    /** Output format: 'human' | 'json'. */
    output: 'human' | 'json';
}
/**
 * Programmatic entry — also called by bin.ts for the CLI.
 * Reads VIVA_* env via loadConfigFromEnv() and branches on config.mode.
 *
 * @param opts  - CLI run options.
 * @param env   - Optional env override (defaults to process.env). Used in tests.
 * @param dispatcher - Optional undici Dispatcher override (MockAgent in tests).
 */
export declare function run(opts: RunOptions, env?: NodeJS.ProcessEnv, dispatcher?: Dispatcher): Promise<number>;
export {};
//# sourceMappingURL=register-webhooks.d.ts.map