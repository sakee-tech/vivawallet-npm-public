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
import type { MedusaRequest, MedusaResponse } from '@medusajs/framework/http';
export declare const GET: (req: MedusaRequest<unknown, {
    id: string;
}>, res: MedusaResponse) => Promise<void>;
//# sourceMappingURL=route.d.ts.map