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
import type { MedusaRequest, MedusaResponse } from '@medusajs/framework/http';
export declare const POST: (req: MedusaRequest, res: MedusaResponse) => Promise<void>;
//# sourceMappingURL=route.d.ts.map