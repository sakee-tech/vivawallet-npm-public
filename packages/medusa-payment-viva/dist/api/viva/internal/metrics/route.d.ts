/**
 * route.ts — GET /viva/internal/metrics
 *
 * Admin-guarded Prometheus text format scrape endpoint.
 * Returns in-process metric counters and histograms from PromMetricsHook.
 *
 * Auth gate: same X-Viva-Admin-Token / VIVA_ADMIN_TOKEN as auth-status.
 *
 * @see references/viva-docs/md/isv-partner-program.txt:61 (P16 observability)
 */
import type { MedusaRequest, MedusaResponse } from '@medusajs/framework/http';
export declare const GET: (req: MedusaRequest, res: MedusaResponse) => Promise<void>;
//# sourceMappingURL=route.d.ts.map