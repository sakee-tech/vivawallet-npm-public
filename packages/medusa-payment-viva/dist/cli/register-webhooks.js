"use strict";
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
Object.defineProperty(exports, "__esModule", { value: true });
exports.run = run;
const isv_1 = require("@sakeetech/viva-payments-core/isv");
const auth_1 = require("@sakeetech/viva-payments-core/auth");
const legacy_1 = require("@sakeetech/viva-payments-core/legacy");
const errors_1 = require("@sakeetech/viva-payments-core/errors");
const webhooks_1 = require("@sakeetech/viva-payments-core/webhooks");
const config_js_1 = require("../config.js");
const plan_js_1 = require("./plan.js");
const MERCHANT_EVENTS = Object.freeze([
    { id: 1796, name: 'Transaction Payment Created' },
    { id: 1797, name: 'Transaction Reversal Created' },
    { id: 1798, name: 'Transaction Payment Failed' },
    { id: 4865, name: 'Order Updated' },
]);
// ---------------------------------------------------------------------------
// Main entry
// ---------------------------------------------------------------------------
/**
 * Programmatic entry — also called by bin.ts for the CLI.
 * Reads VIVA_* env via loadConfigFromEnv() and branches on config.mode.
 *
 * @param opts  - CLI run options.
 * @param env   - Optional env override (defaults to process.env). Used in tests.
 * @param dispatcher - Optional undici Dispatcher override (MockAgent in tests).
 */
async function run(opts, env, dispatcher) {
    const effectiveEnv = env ?? process.env;
    // -------------------------------------------------------------------------
    // 1. Load + validate config.
    // -------------------------------------------------------------------------
    let config;
    try {
        config = (0, config_js_1.loadConfigFromEnv)(effectiveEnv);
    }
    catch (err) {
        if (err instanceof errors_1.VivaValidationError) {
            console.error(`[viva-register-webhooks] Config error: ${err.message}`);
        }
        else {
            console.error(`[viva-register-webhooks] Unexpected config error: ${String(err)}`);
        }
        return 3;
    }
    // -------------------------------------------------------------------------
    // 2. Resolve webhook base URL (mode-agnostic).
    // -------------------------------------------------------------------------
    const webhookBaseUrl = opts.webhookBaseUrl ?? effectiveEnv['VIVA_WEBHOOK_BASE_URL'];
    if (!webhookBaseUrl) {
        console.error('[viva-register-webhooks] VIVA_WEBHOOK_BASE_URL is required (or pass --webhook-base-url).');
        return 3;
    }
    // Strip trailing slash for consistent URL construction.
    const baseUrl = webhookBaseUrl.replace(/\/$/, '');
    const webhookUrl = `${baseUrl}/viva/webhook`;
    // -------------------------------------------------------------------------
    // 3. Branch on mode.
    // -------------------------------------------------------------------------
    if (config.mode === 'merchant') {
        return runMerchant({
            config,
            opts,
            webhookUrl,
            ...(dispatcher !== undefined ? { dispatcher } : {}),
        });
    }
    return runIsv({
        config,
        opts,
        webhookUrl,
        baseUrl,
        ...(dispatcher !== undefined ? { dispatcher } : {}),
    });
}
async function runMerchant(input) {
    const { config, opts, webhookUrl, dispatcher } = input;
    // --reconcile-drift is non-applicable: Viva merchants cannot list/deactivate
    // webhooks via API — Self Care UI is the only management surface.
    if (opts.reconcileDrift) {
        if (opts.output === 'json') {
            console.log(JSON.stringify({
                mode: 'merchant',
                error: 'reconcile-drift-not-supported',
                message: '--reconcile-drift is not supported in merchant mode (manual setup only). ' +
                    'ISV mode uses this flag against POST /isv/v1/webhooks.',
            }, null, 2));
        }
        else {
            console.log('--reconcile-drift is not supported in merchant mode (manual setup only).');
            console.log('ISV mode uses this flag against POST /isv/v1/webhooks.');
        }
        return 0;
    }
    // --dry-run: print expected URLs + placeholder for key, skip the network call.
    if (opts.dryRun) {
        printMerchantInstructions({
            webhookUrl,
            verificationKey: undefined,
            output: opts.output,
        });
        return 0;
    }
    // --apply: fetch verification key from Viva legacy host, then print instructions.
    if (opts.apply) {
        const basicAuth = new legacy_1.BasicAuthClient({
            authVariant: 'merchant',
            environment: config.environment,
            merchantId: config.legacyMerchantId,
            apiKey: config.legacyApiKey,
            ...(dispatcher !== undefined ? { dispatcher } : {}),
        });
        let verificationKey;
        try {
            verificationKey = await basicAuth.fetchWebhookVerificationKey();
        }
        catch (err) {
            const msg = err instanceof errors_1.VivaApiError ? err.message : String(err);
            console.error(`[viva-register-webhooks] Failed to fetch verification key: ${msg}`);
            return 2;
        }
        printMerchantInstructions({
            webhookUrl,
            verificationKey,
            output: opts.output,
        });
        return 0;
    }
    // Neither --dry-run nor --apply (should be caught by bin.ts but guard here).
    console.error('[viva-register-webhooks] Specify --dry-run or --apply.');
    return 3;
}
function printMerchantInstructions(input) {
    const { webhookUrl, verificationKey, output } = input;
    if (output === 'json') {
        console.log(JSON.stringify({
            mode: 'merchant',
            verificationKey: verificationKey ?? '<dry-run — verification key not fetched>',
            events: MERCHANT_EVENTS.map((e) => ({
                id: e.id,
                name: e.name,
                url: webhookUrl,
            })),
        }, null, 2));
        return;
    }
    // Human-readable.
    console.log('');
    console.log('Manual webhook setup required (merchant mode).');
    console.log('');
    console.log('1. Go to Viva Self Care → Sales → API Access → Webhooks.');
    console.log('2. For each event below, register the URL with your storefront base URL:');
    console.log('');
    for (const e of MERCHANT_EVENTS) {
        console.log(`   ${e.name} (${e.id}): ${webhookUrl}`);
    }
    console.log('');
    console.log('3. Paste this verification key into VIVA_WEBHOOK_VERIFICATION_KEY in .env:');
    console.log(`   ${verificationKey ?? '<dry-run — verification key not fetched>'}`);
    console.log('');
    console.log('4. Restart your Medusa server.');
    console.log('');
}
async function runIsv(input) {
    const { config, opts, webhookUrl, baseUrl, dispatcher } = input;
    // -------------------------------------------------------------------------
    // Build IsvWebhooks client.
    // Inject dispatcher when provided (undici MockAgent in tests).
    // The OAuth2 strategy also needs the dispatcher so that MockAgent
    // intercepts both /connect/token and /api/accounts/webhooks calls.
    // -------------------------------------------------------------------------
    const cache = new auth_1.InMemoryTokenCache();
    const mutex = new auth_1.AsyncMutex();
    const primary = new auth_1.OAuth2ClientCredentialsStrategy({
        environment: config.environment,
        clientId: config.clientId,
        clientSecret: config.clientSecret,
        cache,
        mutex,
        ...(dispatcher !== undefined ? { dispatcher } : {}),
    });
    const httpClient = new isv_1.IsvHttpClient({
        environment: config.environment,
        authStrategy: primary,
        ...(dispatcher !== undefined ? { dispatcher } : {}),
    });
    const isvWebhooks = new isv_1.IsvWebhooks(httpClient);
    // -------------------------------------------------------------------------
    // Build desired state from V1_EVENT_TYPE_IDS.
    // One URL per event type, all pointing to the same endpoint.
    // -------------------------------------------------------------------------
    const desired = webhooks_1.V1_EVENT_TYPE_IDS.map((eventTypeId) => ({
        eventTypeId,
        url: webhookUrl,
        description: `viva-register-webhooks v1 (eventTypeId=${eventTypeId})`,
    }));
    // -------------------------------------------------------------------------
    // Fetch current registrations.
    //
    // The ISV API exposes no list endpoint (probe-verified 2026-05-11). The
    // computePlan model still expects a `current` slice, so we feed it an
    // empty list — plan output reduces to REGISTER actions only. Drift
    // reconciliation is a no-op (kept as a flag so callers don't break, but
    // it cannot detect anything to deactivate).
    // -------------------------------------------------------------------------
    const current = [];
    if (opts.reconcileDrift) {
        console.warn('[viva-register-webhooks] --reconcile-drift is a no-op: the ISV API does not expose list/deactivate endpoints. ' +
            'Existing webhook drift must be cleaned up via the Viva self-care UI.');
    }
    // -------------------------------------------------------------------------
    // Compute plan.
    // -------------------------------------------------------------------------
    const planInput = {
        desired,
        current,
        reconcileDrift: opts.reconcileDrift ?? false,
    };
    // Only pass ownedHostnamePattern when reconciling to satisfy exactOptionalPropertyTypes.
    if (opts.reconcileDrift) {
        planInput.ownedHostnamePattern = buildOwnedPattern(baseUrl);
    }
    const plan = (0, plan_js_1.computePlan)(planInput);
    // -------------------------------------------------------------------------
    // Dry-run: print and exit.
    // -------------------------------------------------------------------------
    if (opts.dryRun) {
        printPlan(plan, opts.output);
        if (plan.hasFatalError) {
            return 3;
        }
        const hasActions = plan.actions.some((a) => a.kind === 'REGISTER' || a.kind === 'DEACTIVATE_DRIFT');
        return hasActions ? 1 : 0;
    }
    // -------------------------------------------------------------------------
    // Apply.
    // -------------------------------------------------------------------------
    if (opts.apply) {
        // Abort immediately if the plan has a fatal error.
        if (plan.hasFatalError) {
            printPlan(plan, opts.output);
            console.error('[viva-register-webhooks] Aborting: ABORT_LIMIT_HIT in plan. ' +
                'Deregister unused webhooks before retrying.');
            return 3;
        }
        printPlan(plan, opts.output);
        const actionsToApply = plan.actions.filter((a) => a.kind === 'REGISTER' || a.kind === 'DEACTIVATE_DRIFT');
        for (const action of actionsToApply) {
            if (action.kind === 'REGISTER') {
                try {
                    await isvWebhooks.registerWebhook({
                        eventTypeId: action.desired.eventTypeId,
                        url: action.desired.url,
                    });
                    logLine(opts.output, 'applied', `REGISTER eventTypeId=${action.desired.eventTypeId} url=${action.desired.url}`);
                }
                catch (err) {
                    const msg = err instanceof errors_1.VivaApiError
                        ? err.message
                        : String(err);
                    console.error(`[viva-register-webhooks] REGISTER failed for eventTypeId=${action.desired.eventTypeId}: ${msg}`);
                    return 2;
                }
            }
            // DEACTIVATE_DRIFT is unreachable: current=[] means computePlan never emits it.
        }
        logLine(opts.output, 'done', `Applied ${actionsToApply.length} action(s).`);
        return 0;
    }
    // Neither --dry-run nor --apply (should be caught by bin.ts but guard here).
    console.error('[viva-register-webhooks] Specify --dry-run or --apply.');
    return 3;
}
// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
/**
 * Builds a RegExp that matches URLs containing the hostname extracted from baseUrl.
 *
 * Used for drift reconciliation to avoid touching webhooks that belong to
 * other operators on the same ISV account.
 */
function buildOwnedPattern(baseUrl) {
    try {
        const { hostname } = new URL(baseUrl);
        // Escape dots for use in RegExp.
        const escaped = hostname.replace(/\./g, '\\.');
        return new RegExp(escaped);
    }
    catch {
        // If URL parsing fails, fall back to a pattern that matches everything.
        return /.*/;
    }
}
function printPlan(plan, output) {
    if (output === 'json') {
        console.log(JSON.stringify({ plan: plan.actions, hasFatalError: plan.hasFatalError }, null, 2));
        return;
    }
    // Human-readable table.
    console.log('');
    console.log('viva-register-webhooks — Plan');
    console.log('─'.repeat(72));
    if (plan.actions.length === 0) {
        console.log('  (no actions — all webhooks already registered)');
        console.log('');
        return;
    }
    for (const action of plan.actions) {
        const line = formatAction(action);
        console.log(`  ${line}`);
    }
    console.log('─'.repeat(72));
    console.log(`  ${plan.actions.length} action(s) | fatal=${plan.hasFatalError}`);
    console.log('');
}
function formatAction(action) {
    switch (action.kind) {
        case 'REGISTER':
            return `[REGISTER]         eventTypeId=${action.desired.eventTypeId}  url=${action.desired.url}`;
        case 'SKIP_ALREADY_REGISTERED':
            return `[SKIP]             eventTypeId=${action.existing.eventTypeId}  url=${action.existing.url}`;
        case 'DEACTIVATE_DRIFT':
            return `[DEACTIVATE_DRIFT] eventTypeId=${action.existing.eventTypeId}  url=${action.existing.url}  reason=${action.reason}`;
        case 'WARN_LIMIT_NEAR':
            return `[WARN_LIMIT_NEAR]  eventTypeId=${action.eventTypeId}  current=${action.current}/${action.limit}`;
        case 'ABORT_LIMIT_HIT':
            return `[ABORT_LIMIT_HIT]  eventTypeId=${action.eventTypeId}  current=${action.current}/${action.limit}  (operator must deregister)`;
    }
}
function logLine(output, level, message) {
    if (output === 'json') {
        console.log(JSON.stringify({ level, message, ts: new Date().toISOString() }));
    }
    else {
        console.log(`[${level}] ${message}`);
    }
}
//# sourceMappingURL=register-webhooks.js.map