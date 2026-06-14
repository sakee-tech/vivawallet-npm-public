/**
 * _admin-auth.ts — shared admin-token gate for `/viva/admin/*` routes.
 *
 * Extracted in slice F so all admin routes share one timing-safe token check.
 * Behaviour is identical to the inline copies that previously lived in each
 * route file: reads `VIVA_ADMIN_TOKEN` from the process env, compares it
 * against the `x-viva-admin-token` request header using `timingSafeEqual`,
 * and writes a `401 { error: 'unauthorized' }` envelope on mismatch.
 *
 * When `VIVA_ADMIN_TOKEN` is unset the gate fails closed with
 * `{ error: 'unauthorized', reason: 'admin-token-not-configured' }` — same
 * envelope shape used by `/viva/internal/*` so the operator gets a clear
 * configuration hint without leaking whether a token was provided.
 *
 * @see docs/plans/multi-mode-v0.md §6 (admin REST table)
 */
import type { MedusaRequest, MedusaResponse } from '@medusajs/framework/http';
/**
 * Returns `true` and writes a 401 response when the admin token is missing
 * or invalid. Returns `false` when the request is authorized.
 *
 * Reads `VIVA_ADMIN_TOKEN` lazily from `process.env` so tests can swap it
 * between requests.
 */
export declare function reject401IfUnauthorized(req: MedusaRequest, res: MedusaResponse): boolean;
//# sourceMappingURL=_admin-auth.d.ts.map