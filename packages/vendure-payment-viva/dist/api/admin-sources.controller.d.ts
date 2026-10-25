/**
 * api/admin-sources.controller.ts — ISV-only admin REST for /api/sources wrapping.
 *
 * Single route:
 *
 *   POST /viva/admin/connected-accounts/:id/sources
 *     Creates a payment source (ecommerce or physical) on a connected
 *     merchant's Viva account via POST /api/sources on the legacy host,
 *     authenticated with Reseller Basic auth (per AUTH.md §1.2).
 *
 * Flow:
 *   1. Mode gate: 404 in merchant mode (mirrors Medusa _mode-gate.ts).
 *   2. Reseller gate: 412 VIVA_RESELLER_CREDENTIALS_MISSING when
 *      options.reseller is absent.
 *   3. Body parse: 400 on missing/invalid fields or unknown kind.
 *   4. Account lookup: IsvAccounts.retrieveConnectedAccount(:id).
 *      → 409 VIVA_ACCOUNT_NOT_VERIFIED when verified !== true or
 *        merchantId is null.
 *   5. BasicAuthClient {authVariant:'reseller'} built with the connected
 *      merchant's UUID (account.merchantId — NOT config.reseller.merchantId).
 *   6. IsvSources.createEcommerceSource / createPhysicalSource.
 *   7. For ecommerce sources: persist `vivaSourceCode` (String-coerced) to the
 *      channel resolved by vivaAccountId and assign the `viva` PaymentMethod.
 *      Best-effort — a persistence failure is logged but does not fail the call.
 *   8. 201 with {sourceCode, name, kind}.
 *
 * Viva 4xx on /api/sources → 422 VIVA_SOURCE_CREATION_FAILED.
 * Viva 5xx / auth errors → 503 VIVA_AUTH_DOWN (existing envelope rule).
 *
 * @see docs/plans/multi-mode-v0.md §6 (admin REST table)
 * @see docs/AUTH.md §1.2 (Reseller Basic)
 * @see docs/ENDPOINTS.md §5.1
 * @see packages/medusa-payment-viva/src/api/viva/admin/connected-accounts/[id]/sources/route.ts
 */
import type { ServerResponse } from 'node:http';
import { RequestContextService } from '@vendure/core';
import type { VivaPaymentPluginOptions } from '../types.js';
import type { VivaOAuth2Strategy } from '../providers/viva-oauth2-strategy.provider.js';
import { ConnectedAccountsService } from '../services/connected-accounts.service.js';
export declare class AdminSourcesController {
    private readonly options;
    private readonly oauth2;
    private readonly connectedAccounts;
    private readonly requestContextService;
    constructor(options: VivaPaymentPluginOptions, oauth2: VivaOAuth2Strategy, connectedAccounts: ConnectedAccountsService, requestContextService: RequestContextService);
    /**
     * Narrow options to ISV mode + reseller block.
     * Returns:
     *   - { ok: true, isv } on success.
     *   - { ok: false, status, err } on mode mismatch (404) or missing reseller (412).
     */
    private requireIsvWithReseller;
    /** Build the OAuth2-backed IsvAccounts client (platform creds). */
    private buildIsvAccounts;
    createSource(id: string, body: unknown, res: ServerResponse): Promise<void>;
}
//# sourceMappingURL=admin-sources.controller.d.ts.map