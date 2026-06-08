"use strict";
/**
 * route.ts — POST /viva/admin/connected-accounts/:id/reconcile
 *
 * ISV-only admin endpoint. Forces a re-fetch of the connected-account state
 * from Viva and applies the latest verification/acquiring flags onto the
 * local `viva_tenant_merchant` row (when one exists). Used to recover from
 * missed 8194 webhook deliveries.
 *
 *   1. Validates plugin is in ISV mode (404 in merchant mode).
 *   2. Validates admin token (401 if missing/wrong).
 *   3. Fetches current state via `IsvAccounts.retrieveConnectedAccount`.
 *   4. UPDATEs `viva_tenant_merchant.verification_status` when a row matches.
 *   5. Returns `{ accountId, verified, acquiringEnabled, reconciled }`.
 *
 * @see docs/plans/multi-mode-v0.md §6 (mode-surface gating)
 */
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.POST = void 0;
const pg_1 = __importDefault(require("pg"));
const isv_1 = require("@sakeetech/viva-payments-core/isv");
const errors_1 = require("@sakeetech/viva-payments-core/errors");
const config_js_1 = require("../../../../../../config.js");
const auth_strategy_factory_js_1 = require("../../../../../../resolvers/auth-strategy-factory.js");
const _mode_gate_js_1 = require("../../../_mode-gate.js");
const _admin_auth_js_1 = require("../../../_admin-auth.js");
const POST = async (req, res) => {
    if ((0, _mode_gate_js_1.reject404IfNotIsv)(req, res))
        return;
    if ((0, _admin_auth_js_1.reject401IfUnauthorized)(req, res))
        return;
    const id = req.params?.id;
    if (!id) {
        res.status(400).json({ error: 'id is required' });
        return;
    }
    let pool = null;
    try {
        const config = (0, config_js_1.loadConfigFromEnv)(process.env);
        const authStrategies = (0, auth_strategy_factory_js_1.buildAuthStrategies)(config);
        const httpClient = new isv_1.IsvHttpClient({
            environment: config.environment,
            authStrategy: authStrategies.primary,
        });
        const accounts = new isv_1.IsvAccounts(httpClient);
        const account = await accounts.retrieveConnectedAccount(id);
        // Best-effort sync to viva_tenant_merchant. If no row matches (account
        // hasn't been registered locally yet), report reconciled=false.
        const connString = process.env['DATABASE_URL'] ??
            `postgresql://${process.env['USER'] ?? 'postgres'}@localhost:5432/postgres`;
        pool = new pg_1.default.Pool({ connectionString: connString, max: 1 });
        const verificationStatus = account.verified ? 'verified' : 'unverified';
        const client = await pool.connect();
        let rowCount = 0;
        try {
            const result = await client.query(`UPDATE viva_tenant_merchant
            SET verification_status = $1, updated_at = now()
          WHERE connected_account_id = $2`, [verificationStatus, id]);
            rowCount = result.rowCount ?? 0;
        }
        finally {
            client.release();
        }
        res.status(200).json({
            accountId: account.accountId,
            verified: account.verified,
            acquiringEnabled: account.acquiringEnabled,
            reconciled: rowCount > 0,
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
        logger?.error?.(`[viva] POST /viva/admin/connected-accounts/:id/reconcile failed: ${err instanceof Error ? err.message : String(err)}`);
        res.status(500).json({ error: 'internal_error' });
    }
    finally {
        if (pool)
            await pool.end().catch(() => undefined);
    }
};
exports.POST = POST;
//# sourceMappingURL=route.js.map