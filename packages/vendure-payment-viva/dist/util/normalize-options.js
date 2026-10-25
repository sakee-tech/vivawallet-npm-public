"use strict";
/**
 * util/normalize-options.ts — input validation + back-compat handling for
 * `VivaPaymentPlugin.init()`.
 *
 * Takes the loose `VivaPaymentPluginInitInput` shape (which accepts deprecated
 * field aliases and an optional `mode`) and returns the strict discriminated
 * `VivaPaymentPluginOptions` union.
 *
 * Responsibilities:
 *  1. Resolve deprecated `isvClientId`/`isvClientSecret` → `clientId`/`clientSecret`,
 *     with one-time deprecation warnings.
 *  2. Resolve `mode`: default to `'merchant'` (with a warning), or auto-detect
 *     `'isv'` when ISV-only fields are present (no warning — strong hint).
 *  3. Warn (don't throw) when merchant mode is paired with ISV-only resolvers.
 *  4. Throw a single aggregated error if required fields are missing.
 *
 * Mirrors `medusa-payment-viva/src/config.ts` defaulting + back-compat behaviour
 * (multi-mode-v0 plan §5, §10).
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports._resetInitNoticesForTesting = _resetInitNoticesForTesting;
exports.normalizePluginOptions = normalizePluginOptions;
const errors_1 = require("@sakeetech/viva-payments-core/errors");
// ---------------------------------------------------------------------------
// One-shot warning latches (process-level)
// ---------------------------------------------------------------------------
let _isvClientIdAliasWarned = false;
let _isvClientSecretAliasWarned = false;
let _defaultModeNoticeShown = false;
let _merchantWithIsvResolversWarned = false;
/** @internal Test-only: reset all one-time warning latches. */
function _resetInitNoticesForTesting() {
    _isvClientIdAliasWarned = false;
    _isvClientSecretAliasWarned = false;
    _defaultModeNoticeShown = false;
    _merchantWithIsvResolversWarned = false;
}
// ---------------------------------------------------------------------------
// Normalizer
// ---------------------------------------------------------------------------
const ISV_ONLY_KEYS = [
    'resolveMerchantId',
    'resolveSourceCode',
    'resolveIsvAmount',
    'resolveCheckoutColor',
    'onboardingReturnUrl',
    'onboardingBranding',
    'reseller',
];
const MERCHANT_ONLY_KEYS = [
    'sourceCode',
    'checkoutColor',
];
function normalizePluginOptions(input) {
    const errors = [];
    // -------------------------------------------------------------------------
    // 1. clientId / clientSecret — accept deprecated aliases.
    // -------------------------------------------------------------------------
    let clientId = input.clientId;
    if (!clientId && input.isvClientId) {
        clientId = input.isvClientId;
        if (!_isvClientIdAliasWarned) {
            _isvClientIdAliasWarned = true;
            console.warn('[viva] `isvClientId` is deprecated, rename to `clientId`. ' +
                'Removal in 0.3.0.');
        }
    }
    if (!clientId) {
        errors.push('clientId is required');
    }
    let clientSecret = input.clientSecret;
    if (!clientSecret && input.isvClientSecret) {
        clientSecret = input.isvClientSecret;
        if (!_isvClientSecretAliasWarned) {
            _isvClientSecretAliasWarned = true;
            console.warn('[viva] `isvClientSecret` is deprecated, rename to `clientSecret`. ' +
                'Removal in 0.3.0.');
        }
    }
    if (!clientSecret) {
        errors.push('clientSecret is required');
    }
    // -------------------------------------------------------------------------
    // 2. Resolve mode (with auto-detect + default warning).
    // -------------------------------------------------------------------------
    const isvFieldsPresent = ISV_ONLY_KEYS.some((k) => input[k] !== undefined);
    let mode;
    if (input.mode === 'merchant' || input.mode === 'isv') {
        mode = input.mode;
    }
    else if (input.mode === undefined) {
        mode = isvFieldsPresent ? 'isv' : 'merchant';
        if (!isvFieldsPresent && !_defaultModeNoticeShown) {
            _defaultModeNoticeShown = true;
            console.warn(`[viva] mode is unset — defaulting to 'merchant'. ` +
                `Pass mode: 'isv' if running under an ISV partner.`);
        }
    }
    else {
        errors.push(`mode must be 'merchant' or 'isv', got '${String(input.mode)}'`);
        mode = 'merchant'; // placeholder
    }
    // -------------------------------------------------------------------------
    // 3. Warn when merchant mode is paired with ISV-only resolvers/fields.
    // -------------------------------------------------------------------------
    if (mode === 'merchant' && isvFieldsPresent && !_merchantWithIsvResolversWarned) {
        const presentKeys = ISV_ONLY_KEYS.filter((k) => input[k] !== undefined);
        _merchantWithIsvResolversWarned = true;
        console.warn(`[viva] mode='merchant' but ISV-only field(s) supplied: ${presentKeys.join(', ')}. ` +
            `These values are ignored in merchant mode.`);
    }
    // -------------------------------------------------------------------------
    // 4. Required common fields.
    // -------------------------------------------------------------------------
    if (!input.environment) {
        errors.push('environment is required');
    }
    // Merchant Basic creds are MERCHANT-MODE-ONLY. In ISV mode they are
    // inapplicable: an ISV never holds a connected merchant's ApiKey, and the ISV
    // refund authenticates with the Viva-issued Reseller pair (checked at refund
    // time via options.reseller). The merchant webhook-key fetch + Standard refund
    // are the only consumers, both merchant-mode.
    // @see docs/internal/payment-isv-api.yaml:2650
    if (mode === 'merchant') {
        if (!input.legacyMerchantId) {
            errors.push('legacyMerchantId is required in merchant mode — Merchant Basic auth for createRefund.');
        }
        if (!input.legacyApiKey) {
            errors.push('legacyApiKey is required in merchant mode — Merchant Basic auth for createRefund.');
        }
    }
    if (!input.webhookVerificationKey) {
        errors.push('webhookVerificationKey is required');
    }
    if (input.successUrl === undefined) {
        errors.push('successUrl is required');
    }
    if (input.failureUrl === undefined) {
        errors.push('failureUrl is required');
    }
    // ISV mode: onboardingReturnUrl required (Viva ISV API rejects without it).
    if (mode === 'isv' && input.onboardingReturnUrl === undefined) {
        errors.push("onboardingReturnUrl is required when mode='isv' " +
            '(POST /isv/v1/accounts rejects requests without it).');
    }
    // -------------------------------------------------------------------------
    // 5. Throw aggregated validation errors before composing.
    // -------------------------------------------------------------------------
    if (errors.length > 0) {
        throw new errors_1.VivaValidationError({
            message: `Invalid Viva plugin options:\n  ${errors.join('\n  ')}`,
        });
    }
    // -------------------------------------------------------------------------
    // 6. Compose common fields (we've already validated everything above —
    // the non-null assertions are safe here).
    // -------------------------------------------------------------------------
    const common = {
        environment: input.environment,
        clientId: clientId,
        clientSecret: clientSecret,
        legacyMerchantId: input.legacyMerchantId,
        legacyApiKey: input.legacyApiKey,
        webhookVerificationKey: input.webhookVerificationKey,
        successUrl: input.successUrl,
        failureUrl: input.failureUrl,
        ...(input.refundStrategy !== undefined ? { refundStrategy: input.refundStrategy } : {}),
        ...(input.redlock !== undefined ? { redlock: input.redlock } : {}),
        ...(input.logger !== undefined ? { logger: input.logger } : {}),
        ...(input.metricsHook !== undefined ? { metricsHook: input.metricsHook } : {}),
        ...(input.tracer !== undefined ? { tracer: input.tracer } : {}),
        ...(input.webhookIpAllowlist !== undefined ? { webhookIpAllowlist: input.webhookIpAllowlist } : {}),
        ...(input.trustedProxyDepth !== undefined ? { trustedProxyDepth: input.trustedProxyDepth } : {}),
    };
    if (mode === 'merchant') {
        const merchant = {
            ...common,
            mode: 'merchant',
            ...(input.sourceCode !== undefined ? { sourceCode: input.sourceCode } : {}),
            ...(input.checkoutColor !== undefined ? { checkoutColor: input.checkoutColor } : {}),
        };
        return merchant;
    }
    // mode === 'isv'
    const isv = {
        ...common,
        mode: 'isv',
        onboardingReturnUrl: input.onboardingReturnUrl,
        ...(input.resolveMerchantId !== undefined ? { resolveMerchantId: input.resolveMerchantId } : {}),
        ...(input.resolveSourceCode !== undefined ? { resolveSourceCode: input.resolveSourceCode } : {}),
        ...(input.resolveIsvAmount !== undefined ? { resolveIsvAmount: input.resolveIsvAmount } : {}),
        ...(input.resolveCheckoutColor !== undefined ? { resolveCheckoutColor: input.resolveCheckoutColor } : {}),
        ...(input.onboardingBranding !== undefined ? { onboardingBranding: input.onboardingBranding } : {}),
        ...(input.reseller !== undefined ? { reseller: input.reseller } : {}),
    };
    // Suppress unused-key warnings for merchant-only fields under ISV mode.
    void MERCHANT_ONLY_KEYS;
    return isv;
}
//# sourceMappingURL=normalize-options.js.map