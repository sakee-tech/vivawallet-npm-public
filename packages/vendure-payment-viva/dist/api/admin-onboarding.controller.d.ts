/**
 * api/admin-onboarding.controller.ts — Connected Accounts onboarding admin REST endpoints.
 *
 * Routes (all under /viva/admin/connected-accounts):
 *
 *   POST   /viva/admin/connected-accounts
 *     Initiate onboarding for a channel. Calls IsvAccounts.createConnectedAccount,
 *     writes vivaAccountId to the channel, returns {accountId, onboardingUrl}.
 *
 *   GET    /viva/admin/connected-accounts/:channelId
 *     Return onboarding status: {accountId, merchantId, payoutsEnabled,
 *     verificationStatus, applePayDomainVerified}.
 *     Optionally hits IsvAccounts.retrieveConnectedAccount (cached 30s) for a
 *     richer verificationStatus when the channel has an accountId.
 *
 *   POST   /viva/admin/connected-accounts/:channelId/reconcile
 *     Manual recovery if webhook 8194 was missed. Calls
 *     IsvAccounts.retrieveConnectedAccount and, if verified, writes vivaMerchantId
 *     then flips vivaPayoutsEnabled=true via ConnectedAccountsService (preserving
 *     the mandatory field-write order).
 *
 * Auth: @Allow(Permission.SuperAdmin) on every handler.
 *
 * Error envelope: every error response is VivaPluginError.toJSON() shape.
 *
 * @see docs/plans/vendure-plugin-v0.md §"API Surface — REST endpoints"
 * @see docs/plans/vendure-plugin-v0.md §"Onboarding Flow (§10)"
 * @see docs/plans/vendure-plugin-v0.md §"Build Plan — V9"
 * @see docs/VENDURE-CONTRACT.MD §10
 */
import type { ServerResponse } from 'node:http';
import { TransactionalConnection, RequestContextService } from '@vendure/core';
import type { CreateConnectedAccountRequest } from '@sakeetech/viva-payments-core/types';
import type { VivaPaymentPluginOptions } from '../types.js';
import type { VivaOAuth2Strategy } from '../providers/viva-oauth2-strategy.provider.js';
import { ConnectedAccountsService } from '../services/connected-accounts.service.js';
interface InitiateOnboardingBody {
    channelId: string;
    overrides?: Partial<CreateConnectedAccountRequest>;
}
export declare class AdminOnboardingController {
    private readonly options;
    private readonly oauth2;
    private readonly connection;
    private readonly requestContextService;
    private readonly connectedAccountsService;
    constructor(options: VivaPaymentPluginOptions, oauth2: VivaOAuth2Strategy, connection: TransactionalConnection, requestContextService: RequestContextService, connectedAccountsService: ConnectedAccountsService);
    /**
     * Narrow options to ISV mode or throw `VIVA_MODE_MISMATCH`.
     * Onboarding is inherently an ISV-only flow (POST /isv/v1/accounts) — the
     * merchant-mode equivalent is direct Self Care signup with no API surface.
     * Slice C will gate the controller registration itself; slice A throws at
     * runtime entry points.
     */
    private isvOptions;
    private buildIsvAccounts;
    /**
     * Load a channel by id from the raw TypeORM connection.
     * Returns null if not found.
     */
    private loadChannel;
    /**
     * Map a core SDK error to an HTTP status + VivaPluginError JSON body and
     * write it to the response.
     */
    private sendVivaError;
    initiateOnboarding(body: InitiateOnboardingBody, res: ServerResponse): Promise<void>;
    getStatus(channelId: string, res: ServerResponse): Promise<void>;
    reconcile(channelId: string, res: ServerResponse): Promise<void>;
}
export {};
//# sourceMappingURL=admin-onboarding.controller.d.ts.map