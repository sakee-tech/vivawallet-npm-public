"use strict";
/**
 * IsvAccounts — ISV Connected Account API methods.
 *
 * Probe-verified 2026-05-11 against the live demo environment. Endpoints below
 * match the canonical spec at `docs/payment-isv-api.yaml`.
 *
 *   - createConnectedAccount   → POST /isv/v1/accounts
 *   - retrieveConnectedAccount → GET  /isv/v1/accounts/{accountId}
 *
 * Update is NOT implemented: the ISV spec exposes no update endpoint. The
 * merchant edits their own account via the Viva self-care UI.
 *
 * Auth: OAuth2 Bearer with scopes
 *   `urn:viva:payments:core:api:isv urn:viva:payments:core:api:redirectcheckout`.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.IsvAccounts = void 0;
class IsvAccounts {
    client;
    constructor(client) {
        this.client = client;
    }
    /**
     * Create a connected merchant account.
     *
     * Returns `{accountId, invitation: {email, redirectUrl, created}}`. Share
     * `invitation.redirectUrl` with the merchant to complete Viva-hosted KYC.
     * The onboarding URL is only functional in production.
     */
    async createConnectedAccount(req) {
        const wireBody = {
            email: req.email,
            returnUrl: req.returnUrl,
        };
        if (req.branding !== undefined) {
            wireBody['branding'] = req.branding;
        }
        return this.client.request({
            method: 'POST',
            path: '/isv/v1/accounts',
            body: wireBody,
            idempotent: true,
            endpoint: 'POST /isv/v1/accounts',
        });
    }
    /**
     * Retrieve a connected account.
     *
     * Returns the verification status (`verified`), the assigned `merchantId`
     * (null until KYC is complete), and `acquiringEnabled` (true when the
     * merchant can accept card payments).
     */
    async retrieveConnectedAccount(connectedAccountId) {
        return this.client.request({
            method: 'GET',
            path: `/isv/v1/accounts/${connectedAccountId}`,
            idempotent: true,
            endpoint: 'GET /isv/v1/accounts/{accountId}',
        });
    }
}
exports.IsvAccounts = IsvAccounts;
//# sourceMappingURL=accounts.js.map