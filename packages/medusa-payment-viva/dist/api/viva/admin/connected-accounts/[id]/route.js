"use strict";
/**
 * route.ts — GET /viva/admin/connected-accounts/:id
 *
 * ISV-only admin endpoint. Returns the current onboarding/verification status
 * of a connected account by id.
 *
 *   1. Validates plugin is in ISV mode (404 in merchant mode).
 *   2. Validates admin token (401 if missing/wrong).
 *   3. Calls `IsvAccounts.retrieveConnectedAccount` against Viva.
 *   4. Returns the response body.
 *
 * @see docs/plans/multi-mode-v0.md §6 (mode-surface gating)
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.GET = void 0;
const isv_1 = require("@sakeetech/viva-payments-core/isv");
const errors_1 = require("@sakeetech/viva-payments-core/errors");
const config_js_1 = require("../../../../../config.js");
const auth_strategy_factory_js_1 = require("../../../../../resolvers/auth-strategy-factory.js");
const _mode_gate_js_1 = require("../../_mode-gate.js");
const _admin_auth_js_1 = require("../../_admin-auth.js");
const GET = async (req, res) => {
    if ((0, _mode_gate_js_1.reject404IfNotIsv)(req, res))
        return;
    if ((0, _admin_auth_js_1.reject401IfUnauthorized)(req, res))
        return;
    const id = req.params?.id;
    if (!id) {
        res.status(400).json({ error: 'id is required' });
        return;
    }
    try {
        const config = (0, config_js_1.loadConfigFromEnv)(process.env);
        const authStrategies = (0, auth_strategy_factory_js_1.buildAuthStrategies)(config);
        const httpClient = new isv_1.IsvHttpClient({
            environment: config.environment,
            authStrategy: authStrategies.primary,
        });
        const accounts = new isv_1.IsvAccounts(httpClient);
        const account = await accounts.retrieveConnectedAccount(id);
        res.status(200).json(account);
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
        logger?.error?.(`[viva] GET /viva/admin/connected-accounts/:id failed: ${err instanceof Error ? err.message : String(err)}`);
        res.status(500).json({ error: 'internal_error' });
    }
};
exports.GET = GET;
//# sourceMappingURL=route.js.map