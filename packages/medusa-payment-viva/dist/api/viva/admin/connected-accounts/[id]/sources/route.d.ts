/**
 * route.ts — POST /viva/admin/connected-accounts/:id/sources
 *
 * ISV-only admin endpoint. Creates a payment source (ecommerce or physical)
 * on a connected merchant's Viva account via `POST /api/sources` on the
 * legacy host, authenticated with **Reseller Basic** auth.
 *
 *   1. Validates plugin is in ISV mode (404 in merchant mode).
 *   2. Validates admin token (401 if missing/wrong).
 *   3. Requires `config.reseller` (412 with `VIVA_RESELLER_CREDENTIALS_MISSING`).
 *   4. Resolves the connected merchant's `merchantId` UUID via
 *      `IsvAccounts.retrieveConnectedAccount(:id)` — 409 with
 *      `VIVA_ACCOUNT_NOT_VERIFIED` when `verified !== true` or `merchantId`
 *      is null.
 *   5. Builds a per-request `BasicAuthClient` with `authVariant: 'reseller'`
 *      whose username slot carries `resellerId:account.merchantId` (NOT the
 *      platform's merchant id — see AUTH.md §1.2 line 98 + ENDPOINTS.md §5.1).
 *   6. Calls `IsvSources.createEcommerceSource` or `createPhysicalSource`
 *      based on the body's `kind` discriminator.
 *   7. Returns 201 + `{ sourceCode, name, kind }`.
 *
 * Viva 4xx on `/api/sources` is mapped to 422 with `VIVA_SOURCE_CREATION_FAILED`.
 * Viva 5xx / non-API errors fall through to the existing 5xx envelope.
 *
 * @see docs/plans/multi-mode-v0.md §6 (admin REST table)
 * @see docs/ENDPOINTS.md §5.1
 * @see docs/AUTH.md §1.2 (Reseller Basic)
 * @see docs/ERRORS.md (VIVA_SOURCE_CREATION_FAILED, VIVA_RESELLER_CREDENTIALS_MISSING)
 */
import type { MedusaRequest, MedusaResponse } from '@medusajs/framework/http';
export declare const POST: (req: MedusaRequest<unknown, {
    id: string;
}>, res: MedusaResponse) => Promise<void>;
//# sourceMappingURL=route.d.ts.map