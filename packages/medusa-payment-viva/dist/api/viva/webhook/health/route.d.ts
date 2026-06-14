/**
 * route.ts — GET /viva/webhook/health
 *
 * Liveness probe. No auth. Returns 200 { ok: true, environment, timestamp }.
 *
 * @see references/viva-docs/md/isv-partner-program.txt:61 (P16 health endpoints)
 */
import type { MedusaRequest, MedusaResponse } from '@medusajs/framework/http';
/**
 * GET /viva/webhook/health
 *
 * Returns 200 { ok: true } unconditionally.
 * Cache-Control: no-store to prevent proxy caching.
 */
export declare const GET: (_req: MedusaRequest, res: MedusaResponse) => Promise<void>;
//# sourceMappingURL=route.d.ts.map