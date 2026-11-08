/**
 * route.ts — GET /viva/internal/auth-status
 *
 * Admin-guarded endpoint. Returns current OAuth2 token expiry state for
 * readiness checks and debugging.
 *
 * Auth gate: constant-time comparison of X-Viva-Admin-Token header against
 * VIVA_ADMIN_TOKEN env var. 401 if missing or mismatch.
 *
 * Design decision: using env-var shared secret rather than Medusa admin auth
 * because this route is accessed by ops tooling (healthcheck scripts, monitoring
 * agents) that may not have a Medusa admin session. VIVA_ADMIN_TOKEN is rotated
 * independently via secrets manager. Document this choice for operators.
 *
 * @see references/viva-docs/md/isv-partner-program.txt:61 (P16 health endpoints)
 */
import type { MedusaRequest, MedusaResponse } from '@medusajs/framework/http';
export declare const GET: (req: MedusaRequest, res: MedusaResponse) => Promise<void>;
//# sourceMappingURL=route.d.ts.map