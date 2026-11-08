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
import type { MedusaRequest, MedusaResponse } from '@medusajs/framework/http';
export declare const POST: (req: MedusaRequest<unknown, {
    id: string;
}>, res: MedusaResponse) => Promise<void>;
//# sourceMappingURL=route.d.ts.map