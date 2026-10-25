"use strict";
/**
 * route.ts — POST /viva/admin/connected-accounts
 *
 * ISV-only admin endpoint. Initiates a Viva connected-account onboarding flow:
 *   1. Validates that the plugin is in ISV mode (404 in merchant mode).
 *   2. Validates admin token (401 if missing/wrong).
 *   3. Calls `IsvAccounts.createConnectedAccount` against Viva.
 *   4. Returns `{ accountId, onboardingUrl }`.
 *
 * Merchant-mode gating uses Option 2 (per-handler 404 short-circuit) — see
 * `_mode-gate.ts` for the rationale. Medusa v2 has no clean way to skip a
 * `route.ts` file at boot based on plugin config.
 *
 * @see docs/plans/multi-mode-v0.md §6 (mode-surface gating)
 * @see references/viva-docs/md/payment-isv-api.txt:1 (Connected Accounts API)
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.POST = void 0;
const isv_1 = require("@sakeetech/viva-payments-core/isv");
const isv_2 = require("@sakeetech/viva-payments-core/isv");
const errors_1 = require("@sakeetech/viva-payments-core/errors");
const config_js_1 = require("../../../../config.js");
const auth_strategy_factory_js_1 = require("../../../../resolvers/auth-strategy-factory.js");
const _mode_gate_js_1 = require("../_mode-gate.js");
const _admin_auth_js_1 = require("../_admin-auth.js");
const POST = async (req, res) => {
    // 1. Mode gate first — merchant mode pretends route doesn't exist.
    if ((0, _mode_gate_js_1.reject404IfNotIsv)(req, res))
        return;
    // 2. Admin token gate.
    if ((0, _admin_auth_js_1.reject401IfUnauthorized)(req, res))
        return;
    // 3. Body validation.
    const body = (req.body ?? {});
    if (!body.email || typeof body.email !== 'string') {
        res.status(400).json({ error: 'email is required' });
        return;
    }
    if (!body.returnUrl || typeof body.returnUrl !== 'string') {
        res.status(400).json({ error: 'returnUrl is required' });
        return;
    }
    // 4. Build client + call Viva.
    try {
        const config = (0, config_js_1.loadConfigFromEnv)(process.env);
        const authStrategies = (0, auth_strategy_factory_js_1.buildAuthStrategies)(config);
        const httpClient = new isv_1.IsvHttpClient({
            environment: config.environment,
            authStrategy: authStrategies.primary,
        });
        const accounts = new isv_2.IsvAccounts(httpClient);
        const created = await accounts.createConnectedAccount({
            email: body.email,
            returnUrl: body.returnUrl,
            ...(body.branding ? { branding: body.branding } : {}),
        });
        res.status(200).json({
            accountId: created.accountId,
            onboardingUrl: created.invitation.redirectUrl,
        });
    }
    catch (err) {
        if (err instanceof errors_1.VivaApiError) {
            res.status(err.httpStatus ?? 502).json({
                error: 'viva_api_error',
                code: err.code,
                message: err.message,
            });
            return;
        }
        const logger = req.scope?.resolve?.('logger');
        logger?.error?.(`[viva] POST /viva/admin/connected-accounts failed: ${err instanceof Error ? err.message : String(err)}`);
        res.status(500).json({ error: 'internal_error' });
    }
};
exports.POST = POST;
//# sourceMappingURL=route.js.map