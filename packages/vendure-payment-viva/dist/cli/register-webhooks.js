"use strict";
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
Object.defineProperty(exports, "__esModule", { value: true });
exports.run = run;
const isv_1 = require("@sakeetech/viva-payments-core/isv");
const auth_1 = require("@sakeetech/viva-payments-core/auth");
const legacy_1 = require("@sakeetech/viva-payments-core/legacy");
const webhooks_1 = require("@sakeetech/viva-payments-core/webhooks");
const errors_1 = require("@sakeetech/viva-payments-core/errors");
const plan_js_1 = require("./plan.js");
const MERCHANT_EVENTS = Object.freeze([
    { id: 1796, name: 'Transaction Payment Created' },
    { id: 1797, name: 'Transaction Reversal Created' },
    { id: 1798, name: 'Transaction Payment Failed' },
    { id: 4865, name: 'Order Updated' },
]);
// ---------------------------------------------------------------------------
// Mode detection
// ---------------------------------------------------------------------------
function detectMode(env) {
    const explicit = env['VIVA_MODE'];
    if (explicit === 'isv' || explicit === 'merchant')
        return explicit;
    // Default must match the plugin runtime default (merchant) so the CLI
    // doesn't silently dispatch ISV-only API calls for an unset operator who
    // is actually running in merchant mode.
    return 'merchant';
}
// ---------------------------------------------------------------------------
// Retry helper (Viva 5xx → one retry after 2 s)
// ---------------------------------------------------------------------------
async function withRetry(fn) {
    try {
        return await fn();
    }
    catch (err) {
        if (err instanceof errors_1.VivaApiError && err.httpStatus !== undefined && err.httpStatus >= 500) {
            await new Promise((resolve) => setTimeout(resolve, 2000));
            return await fn();
        }
        throw err;
    }
}
// ---------------------------------------------------------------------------
// Main entry
// ---------------------------------------------------------------------------
/**
 * Programmatic entry — also called by bin.ts for the CLI.
 * Reads VIVA_* env from the provided env object (defaults to process.env).
 *
 * @param opts       - CLI run options.
 * @param env        - Optional env override (defaults to process.env). Used in tests.
 * @param dispatcher - Optional undici Dispatcher override (MockAgent in tests).
 */
async function run(opts, env, dispatcher) {
    const effectiveEnv = env ?? process.env;
    const mode = detectMode(effectiveEnv);
    // -------------------------------------------------------------------------
    // 1. Resolve webhook URL (mode-agnostic).
    // -------------------------------------------------------------------------
    const webhookUrl = opts.webhookUrl ?? effectiveEnv['VIVA_WEBHOOK_URL'];
    if (!webhookUrl) {
        console.error('[vendure-viva-register-webhooks] VIVA_WEBHOOK_URL is required (or pass --webhook-url).');
        return 3;
    }
    // -------------------------------------------------------------------------
    // 2. Branch on mode.
    // -------------------------------------------------------------------------
    if (mode === 'merchant') {
        return runMerchant({
            opts,
            webhookUrl,
            env: effectiveEnv,
            ...(dispatcher !== undefined ? { dispatcher } : {}),
        });
    }
    return runIsv({
        opts,
        webhookUrl,
        env: effectiveEnv,
        ...(dispatcher !== undefined ? { dispatcher } : {}),
    });
}
async function runMerchant(input) {
    const { opts, webhookUrl, env, dispatcher } = input;
    // --reconcile-drift is non-applicable in merchant mode (no list/deactivate API).
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
    // --dry-run: print expected URLs without fetching the key.
    if (opts.dryRun) {
        printMerchantInstructions({
            webhookUrl,
            verificationKey: undefined,
            output: opts.output,
        });
        return 0;
    }
    if (!opts.apply) {
        console.error('[vendure-viva-register-webhooks] Specify --dry-run or --apply.');
        return 3;
    }
    // --apply: fetch verification key from Viva legacy host, then print instructions.
    const merchantId = env['VIVA_MERCHANT_ID'];
    const apiKey = env['VIVA_API_KEY'];
    const environment = (env['VIVA_ENVIRONMENT'] ?? 'demo');
    if (!merchantId || !apiKey) {
        console.error('[vendure-viva-register-webhooks] Merchant-mode --apply requires VIVA_MERCHANT_ID and VIVA_API_KEY.');
        return 3;
    }
    const basicAuth = new legacy_1.BasicAuthClient({
        authVariant: 'merchant',
        environment,
        merchantId,
        apiKey,
        ...(dispatcher !== undefined ? { dispatcher } : {}),
    });
    let verificationKey;
    try {
        verificationKey = await basicAuth.fetchWebhookVerificationKey();
    }
    catch (err) {
        const msg = err instanceof errors_1.VivaApiError ? err.message : String(err);
        console.error(`[vendure-viva-register-webhooks] Failed to fetch verification key: ${msg}`);
        return 2;
    }
    printMerchantInstructions({
        webhookUrl,
        verificationKey,
        output: opts.output,
    });
    return 0;
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
    console.log('4. Restart your Vendure server.');
    console.log('');
}
async function runIsv(input) {
    const { opts, webhookUrl, env, dispatcher } = input;
    // -------------------------------------------------------------------------
    // Load ISV OAuth config.
    //
    // Preferred names: VIVA_CLIENT_ID / VIVA_CLIENT_SECRET (0.2.0+).
    // Deprecated aliases: VIVA_ISV_CLIENT_ID / VIVA_ISV_CLIENT_SECRET (removal 0.3.0).
    // -------------------------------------------------------------------------
    let clientId = env['VIVA_CLIENT_ID'];
    if (!clientId && env['VIVA_ISV_CLIENT_ID']) {
        clientId = env['VIVA_ISV_CLIENT_ID'];
        console.warn('[vendure-viva-register-webhooks] VIVA_ISV_CLIENT_ID is deprecated, rename to VIVA_CLIENT_ID. Removal in 0.3.0.');
    }
    let clientSecret = env['VIVA_CLIENT_SECRET'];
    if (!clientSecret && env['VIVA_ISV_CLIENT_SECRET']) {
        clientSecret = env['VIVA_ISV_CLIENT_SECRET'];
        console.warn('[vendure-viva-register-webhooks] VIVA_ISV_CLIENT_SECRET is deprecated, rename to VIVA_CLIENT_SECRET. Removal in 0.3.0.');
    }
    const environment = (env['VIVA_ENVIRONMENT'] ?? 'demo');
    if (!clientId || !clientSecret) {
        console.error('[vendure-viva-register-webhooks] VIVA_CLIENT_ID and VIVA_CLIENT_SECRET are required.');
        return 3;
    }
    // -------------------------------------------------------------------------
    // Build IsvWebhooks client.
    // -------------------------------------------------------------------------
    const cache = new auth_1.InMemoryTokenCache();
    const mutex = new auth_1.AsyncMutex();
    const primary = new auth_1.OAuth2ClientCredentialsStrategy({
        environment,
        clientId,
        clientSecret,
        cache,
        mutex,
        ...(dispatcher !== undefined ? { dispatcher } : {}),
    });
    const httpClient = new isv_1.IsvHttpClient({
        environment,
        authStrategy: primary,
        ...(dispatcher !== undefined ? { dispatcher } : {}),
    });
    const isvWebhooks = new isv_1.IsvWebhooks(httpClient);
    // -------------------------------------------------------------------------
    // Reconcile the ISV webhook verification key (GET /isv/v1/webhooks/token).
    //
    // Viva issues a single verification key per ISV account. The webhook endpoint
    // MUST echo exactly this value during Viva's URL-verify GET handshake, or the
    // registration silently fails to deliver. There is NO fallback: fetch the
    // authoritative key and abort loudly if it isn't configured or doesn't match.
    // (Fixes #17 — the ISV path previously generated a random UUID that could
    // never match Viva's issued key.)
    // -------------------------------------------------------------------------
    let vivaIssuedKey;
    try {
        vivaIssuedKey = (await isvWebhooks.getVerificationKey()).key;
    }
    catch (err) {
        const msg = err instanceof errors_1.VivaApiError ? err.message : String(err);
        console.error(`[vendure-viva-register-webhooks] Could not fetch the ISV webhook verification key ` +
            `(GET /isv/v1/webhooks/token): ${msg}`);
        return 2;
    }
    const configuredKey = env['VIVA_WEBHOOK_VERIFICATION_KEY'];
    if (!configuredKey) {
        console.error(`[vendure-viva-register-webhooks] VIVA_WEBHOOK_VERIFICATION_KEY is not set.\n` +
            `  Viva issued this ISV verification key:\n` +
            `    ${vivaIssuedKey}\n` +
            `  Set VIVA_WEBHOOK_VERIFICATION_KEY to exactly this value in your plugin options and .env\n` +
            `  so the /viva/webhook endpoint echoes it during Viva's URL-verify handshake, then re-run.`);
        return 3;
    }
    if (configuredKey !== vivaIssuedKey) {
        console.error(`[vendure-viva-register-webhooks] VIVA_WEBHOOK_VERIFICATION_KEY does not match the Viva-issued ISV key.\n` +
            `  configured:  ${configuredKey}\n` +
            `  Viva-issued: ${vivaIssuedKey}\n` +
            `  Update VIVA_WEBHOOK_VERIFICATION_KEY to the Viva-issued value and re-run.\n` +
            `  Registration aborted to avoid a webhook whose URL-verify handshake will fail.`);
        return 3;
    }
    if (opts.output !== 'json') {
        console.log('[vendure-viva-register-webhooks] ISV webhook verification key reconciled with Viva (GET /isv/v1/webhooks/token).');
    }
    // -------------------------------------------------------------------------
    // Build desired state from V1_EVENT_TYPE_IDS.
    // One URL per event type, all pointing to the same webhook endpoint.
    // -------------------------------------------------------------------------
    const desired = webhooks_1.V1_EVENT_TYPE_IDS.map((eventTypeId) => ({
        eventTypeId,
        url: webhookUrl,
        description: `vendure-viva-register-webhooks v1 (eventTypeId=${eventTypeId})`,
    }));
    // -------------------------------------------------------------------------
    // Fetch current registrations.
    //
    // The ISV API has no list endpoint (probe-verified 2026-05-11). computePlan
    // still expects a `current` slice, so we feed it `[]` — the plan reduces
    // to REGISTER actions only.
    // -------------------------------------------------------------------------
    const current = [];
    if (opts.reconcileDrift) {
        console.warn('[vendure-viva-register-webhooks] --reconcile-drift is a no-op: the ISV API does not expose list/deactivate endpoints. ' +
            'Clean up existing webhook drift via the Viva self-care UI.');
    }
    // -------------------------------------------------------------------------
    // Compute plan.
    // -------------------------------------------------------------------------
    const planInput = {
        desired,
        current,
        reconcileDrift: opts.reconcileDrift ?? false,
    };
    if (opts.reconcileDrift) {
        planInput.ownedHostnamePattern = (0, plan_js_1.buildOwnedPattern)(webhookUrl);
    }
    const plan = (0, plan_js_1.computePlan)(planInput);
    // -------------------------------------------------------------------------
    // Dry-run: print plan and exit.
    // -------------------------------------------------------------------------
    if (opts.dryRun) {
        printPlan(plan, opts.output);
        if (plan.hasFatalError)
            return 3;
        const hasActions = plan.actions.some((a) => a.kind === 'REGISTER' || a.kind === 'DEACTIVATE_DRIFT');
        return hasActions ? 1 : 0;
    }
    // -------------------------------------------------------------------------
    // Apply.
    // -------------------------------------------------------------------------
    if (opts.apply) {
        if (plan.hasFatalError) {
            printPlan(plan, opts.output);
            console.error('[vendure-viva-register-webhooks] Aborting: ABORT_LIMIT_HIT in plan. ' +
                'Deregister unused webhooks before retrying.');
            return 3;
        }
        printPlan(plan, opts.output);
        const actionsToApply = plan.actions.filter((a) => a.kind === 'REGISTER' || a.kind === 'DEACTIVATE_DRIFT');
        for (const action of actionsToApply) {
            if (action.kind === 'REGISTER') {
                try {
                    await withRetry(() => isvWebhooks.registerWebhook({
                        eventTypeId: action.desired.eventTypeId,
                        url: action.desired.url,
                    }));
                    logLine(opts.output, 'applied', `REGISTER eventTypeId=${action.desired.eventTypeId} url=${action.desired.url}`);
                }
                catch (err) {
                    const msg = err instanceof errors_1.VivaApiError ? err.message : String(err);
                    // 409 Conflict → already registered, treat as no-change
                    if (err instanceof errors_1.VivaApiError && err.httpStatus === 409) {
                        logLine(opts.output, 'skip', `REGISTER eventTypeId=${action.desired.eventTypeId} already exists (409) — no change`);
                        continue;
                    }
                    console.error(`[vendure-viva-register-webhooks] REGISTER failed for eventTypeId=${action.desired.eventTypeId}: ${msg}`);
                    return 2;
                }
            }
            // DEACTIVATE_DRIFT is unreachable: current=[] means computePlan never emits it.
        }
        logLine(opts.output, 'done', `Applied ${actionsToApply.length} action(s).`);
        return 0;
    }
    console.error('[vendure-viva-register-webhooks] Specify --dry-run or --apply.');
    return 3;
}
// ---------------------------------------------------------------------------
// Output helpers (mirror Medusa CLI format)
// ---------------------------------------------------------------------------
function printPlan(plan, output) {
    if (output === 'json') {
        console.log(JSON.stringify({
            plan: plan.actions,
            hasFatalError: plan.hasFatalError,
        }, null, 2));
        return;
    }
    // Human-readable text
    console.log('');
    console.log('vendure-viva-register-webhooks — Plan');
    console.log('─'.repeat(72));
    if (plan.actions.length === 0) {
        console.log('  (no actions — all webhooks already registered)');
        console.log('');
        return;
    }
    for (const action of plan.actions) {
        console.log(`  ${formatAction(action)}`);
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