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
import type { IsvHttpClient } from './client.js';
import type { CreateConnectedAccountRequest, CreateConnectedAccountResponse, GetConnectedAccountResponse, ConnectedAccountId } from '../types/index.js';
export declare class IsvAccounts {
    private readonly client;
    constructor(client: IsvHttpClient);
    /**
     * Create a connected merchant account.
     *
     * Returns `{accountId, invitation: {email, redirectUrl, created}}`. Share
     * `invitation.redirectUrl` with the merchant to complete Viva-hosted KYC.
     * The onboarding URL is only functional in production.
     */
    createConnectedAccount(req: CreateConnectedAccountRequest): Promise<CreateConnectedAccountResponse>;
    /**
     * Retrieve a connected account.
     *
     * Returns the verification status (`verified`), the assigned `merchantId`
     * (null until KYC is complete), and `acquiringEnabled` (true when the
     * merchant can accept card payments).
     */
    retrieveConnectedAccount(connectedAccountId: ConnectedAccountId): Promise<GetConnectedAccountResponse>;
}
//# sourceMappingURL=accounts.d.ts.map