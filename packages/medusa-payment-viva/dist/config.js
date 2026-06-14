"use strict";
/**
 * config.ts — env parsing and runtime validation for medusa-payment-viva.
 *
 * Reads environment variables and returns a strongly-typed `VivaPluginConfig`
 * discriminated union, branching on `mode: 'merchant' | 'isv'`.
 *
 * Plan reference: docs/plans/multi-mode-v0.md §5 (config shape), §9.1 (env vars).
 *
 * Back-compat (one minor — 0.2.x):
 * - `VIVA_ISV_CLIENT_ID` / `VIVA_ISV_CLIENT_SECRET` are accepted as aliases
 *   for `VIVA_CLIENT_ID` / `VIVA_CLIENT_SECRET`, with a deprecation warning.
 *   Removal in 0.3.0.
 *
 * Auto-detect:
 * - If `VIVA_MODE` is unset and any `VIVA_RESELLER_*` is set, mode defaults
 *   to `'isv'`. Otherwise mode defaults to `'merchant'`.
 *
 * Pure function; accepts env as a parameter for testability.
 * No Zod — manual validation per plan P13.
 *
 * @see references/viva-docs/md/isv-credentials.txt:107 (credential types)
 * @see references/viva-docs/md/oauth2-authentication.txt:119 (client_id, client_secret)
 * @see references/viva-docs/md/payment-isv-api.txt:1 (reseller credentials)
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports._resetConfigStartupNoticeForTesting = _resetConfigStartupNoticeForTesting;
exports.loadConfigFromEnv = loadConfigFromEnv;
const errors_1 = require("@sakeetech/viva-payments-core/errors");
// ---------------------------------------------------------------------------
// Module-local startup state — used to ensure the "defaulting to merchant
// mode" notice fires at most once per process.
// ---------------------------------------------------------------------------
let _defaultModeNoticeShown = false;
/** Test-only: reset the once-per-process flag. */
function _resetConfigStartupNoticeForTesting() {
    _defaultModeNoticeShown = false;
}
// ---------------------------------------------------------------------------
// Loader
// ---------------------------------------------------------------------------
/**
 * Parses the plugin configuration from environment variables.
 *
 * Required (both modes):
 *   - VIVA_CLIENT_ID            (alias: VIVA_ISV_CLIENT_ID — deprecated)
 *   - VIVA_CLIENT_SECRET        (alias: VIVA_ISV_CLIENT_SECRET — deprecated)
 *   - VIVA_WEBHOOK_VERIFICATION_KEY
 *   - VIVA_MERCHANT_ID          (legacy Basic auth)
 *   - VIVA_API_KEY              (legacy Basic auth)
 *
 * Optional:
 *   - VIVA_MODE                 ('merchant' | 'isv'; default 'merchant',
 *                                auto-detected as 'isv' when VIVA_RESELLER_* set)
 *   - VIVA_ENVIRONMENT          ('demo' | 'production'; default 'demo')
 *   - VIVA_REFUND_STRATEGY      ('auto' | 'fast' | 'standard'; default 'auto')
 *   - VIVA_SOURCE_CODE          (merchant mode only; default 'Default')
 *   - VIVA_RESELLER_ID,
 *     VIVA_RESELLER_MERCHANT_ID,
 *     VIVA_RESELLER_API_KEY     (ISV mode only; all-or-nothing)
 *   - VIVA_ADMIN_TOKEN
 *
 * @throws VivaValidationError with field-level messages for missing values.
 */
function loadConfigFromEnv(env = process.env) {
    const errors = [];
    // -------------------------------------------------------------------------
    // VIVA_MODE — discriminator, with auto-detect + default-warning.
    // -------------------------------------------------------------------------
    const rawMode = env['VIVA_MODE'];
    const resellerIdRaw = env['VIVA_RESELLER_ID'];
    const resellerMerchantIdRaw = env['VIVA_RESELLER_MERCHANT_ID'];
    const resellerApiKeyRaw = env['VIVA_RESELLER_API_KEY'];
    const anyResellerSet = Boolean(resellerIdRaw || resellerMerchantIdRaw || resellerApiKeyRaw);
    let mode;
    if (rawMode === undefined || rawMode === '') {
        mode = anyResellerSet ? 'isv' : 'merchant';
        if (!_defaultModeNoticeShown) {
            _defaultModeNoticeShown = true;
            console.warn(`[viva] VIVA_MODE is unset — defaulting to '${mode}' mode` +
                (anyResellerSet
                    ? ' (auto-detected from VIVA_RESELLER_*).'
                    : '. Set VIVA_MODE=isv if running under an ISV partner.'));
        }
    }
    else if (rawMode === 'merchant' || rawMode === 'isv') {
        mode = rawMode;
    }
    else {
        errors.push(`VIVA_MODE must be 'merchant' or 'isv', got '${rawMode}'`);
        mode = 'merchant'; // placeholder; we'll throw before using it
    }
    // -------------------------------------------------------------------------
    // VIVA_ENVIRONMENT
    // -------------------------------------------------------------------------
    const rawEnv = env['VIVA_ENVIRONMENT'] ?? 'demo';
    if (rawEnv !== 'demo' && rawEnv !== 'production') {
        errors.push(`VIVA_ENVIRONMENT must be 'demo' or 'production', got '${rawEnv}'`);
    }
    const environment = rawEnv;
    // -------------------------------------------------------------------------
    // OAuth2 client_credentials (with one-minor back-compat aliases).
    // -------------------------------------------------------------------------
    let clientId = env['VIVA_CLIENT_ID'];
    if (!clientId && env['VIVA_ISV_CLIENT_ID']) {
        clientId = env['VIVA_ISV_CLIENT_ID'];
        console.warn('[viva] VIVA_ISV_CLIENT_ID is deprecated, rename to VIVA_CLIENT_ID. ' +
            'Removal in 0.3.0.');
    }
    if (!clientId) {
        errors.push('VIVA_CLIENT_ID is required');
    }
    let clientSecret = env['VIVA_CLIENT_SECRET'];
    if (!clientSecret && env['VIVA_ISV_CLIENT_SECRET']) {
        clientSecret = env['VIVA_ISV_CLIENT_SECRET'];
        console.warn('[viva] VIVA_ISV_CLIENT_SECRET is deprecated, rename to VIVA_CLIENT_SECRET. ' +
            'Removal in 0.3.0.');
    }
    if (!clientSecret) {
        errors.push('VIVA_CLIENT_SECRET is required');
    }
    const webhookVerificationKey = env['VIVA_WEBHOOK_VERIFICATION_KEY'];
    if (!webhookVerificationKey) {
        errors.push('VIVA_WEBHOOK_VERIFICATION_KEY is required');
    }
    // -------------------------------------------------------------------------
    // Legacy Basic-auth credentials — required in both modes for Standard refund.
    // -------------------------------------------------------------------------
    // Merchant Basic creds (VIVA_MERCHANT_ID / VIVA_API_KEY) are MERCHANT-MODE-ONLY.
    // In ISV mode they are inapplicable — the ISV refund authenticates with the
    // Viva-issued Reseller pair scoped to the connected merchant (checked at refund
    // time). Requiring them in ISV would force operators to supply unused creds.
    // @see docs/internal/payment-isv-api.yaml:2650
    const legacyMerchantId = env['VIVA_MERCHANT_ID'];
    const legacyApiKey = env['VIVA_API_KEY'];
    if (mode === 'merchant') {
        if (!legacyMerchantId) {
            errors.push('VIVA_MERCHANT_ID is required in merchant mode — Merchant Basic auth for refundPayment ' +
                '(DELETE /api/transactions/{id} on the legacy host).');
        }
        if (!legacyApiKey) {
            errors.push('VIVA_API_KEY is required in merchant mode — pair with VIVA_MERCHANT_ID for refund auth.');
        }
    }
    // -------------------------------------------------------------------------
    // VIVA_REFUND_STRATEGY (default 'auto').
    // -------------------------------------------------------------------------
    const rawRefundStrategy = env['VIVA_REFUND_STRATEGY'];
    let refundStrategy = 'auto';
    if (rawRefundStrategy !== undefined && rawRefundStrategy !== '') {
        if (rawRefundStrategy === 'auto' ||
            rawRefundStrategy === 'fast' ||
            rawRefundStrategy === 'standard') {
            refundStrategy = rawRefundStrategy;
        }
        else {
            errors.push(`VIVA_REFUND_STRATEGY must be 'auto', 'fast', or 'standard', got '${rawRefundStrategy}'`);
        }
    }
    // -------------------------------------------------------------------------
    // Reseller credentials (ISV-only, all-or-nothing).
    // -------------------------------------------------------------------------
    const resellerSetCount = [
        resellerIdRaw,
        resellerMerchantIdRaw,
        resellerApiKeyRaw,
    ].filter(Boolean).length;
    if (mode === 'merchant' && resellerSetCount > 0) {
        // Don't throw — warn and ignore. Reseller fields are unused in merchant mode.
        console.warn('[viva] VIVA_RESELLER_* env vars are set but VIVA_MODE=merchant. ' +
            'These values are ignored in merchant mode.');
    }
    if (mode === 'isv' && resellerSetCount > 0 && resellerSetCount < 3) {
        const missing = [];
        if (!resellerIdRaw)
            missing.push('VIVA_RESELLER_ID');
        if (!resellerMerchantIdRaw)
            missing.push('VIVA_RESELLER_MERCHANT_ID');
        if (!resellerApiKeyRaw)
            missing.push('VIVA_RESELLER_API_KEY');
        errors.push(`Reseller credentials are partially set. Missing: ${missing.join(', ')}. ` +
            `Either set all three (VIVA_RESELLER_ID, VIVA_RESELLER_MERCHANT_ID, VIVA_RESELLER_API_KEY) or none.`);
    }
    // -------------------------------------------------------------------------
    // Throw aggregated validation errors before constructing the config object.
    // -------------------------------------------------------------------------
    if (errors.length > 0) {
        throw new errors_1.VivaValidationError({
            message: `Invalid Viva plugin configuration:\n  ${errors.join('\n  ')}`,
        });
    }
    // -------------------------------------------------------------------------
    // VIVA_ADMIN_TOKEN — warn in production if missing.
    // -------------------------------------------------------------------------
    const adminToken = env['VIVA_ADMIN_TOKEN'];
    if (!adminToken && environment === 'production') {
        console.warn('[viva] VIVA_ADMIN_TOKEN is not set. Internal endpoints (/viva/internal/*) will return 401.');
    }
    // -------------------------------------------------------------------------
    // Compose common fields.
    // -------------------------------------------------------------------------
    const common = {
        environment,
        clientId: clientId,
        clientSecret: clientSecret,
        // Empty string in ISV mode (Merchant Basic is unused there); buildLegacyClient
        // returns no client when these are empty.
        legacyMerchantId: legacyMerchantId ?? '',
        legacyApiKey: legacyApiKey ?? '',
        webhookVerificationKey: webhookVerificationKey,
        refundStrategy,
        ...(adminToken !== undefined ? { adminToken } : {}),
    };
    // -------------------------------------------------------------------------
    // Branch on mode.
    // -------------------------------------------------------------------------
    if (mode === 'merchant') {
        const sourceCode = env['VIVA_SOURCE_CODE'];
        const merchantConfig = {
            ...common,
            mode: 'merchant',
            ...(sourceCode !== undefined && sourceCode !== ''
                ? { sourceCode }
                : {}),
        };
        return merchantConfig;
    }
    // mode === 'isv'
    const reseller = resellerSetCount === 3
        ? {
            resellerId: resellerIdRaw,
            merchantId: resellerMerchantIdRaw,
            resellerApiKey: resellerApiKeyRaw,
        }
        : undefined;
    const isvConfig = {
        ...common,
        mode: 'isv',
        ...(reseller !== undefined ? { reseller } : {}),
    };
    return isvConfig;
}
//# sourceMappingURL=config.js.map