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
export const GET = async (
  _req: MedusaRequest,
  res: MedusaResponse,
): Promise<void> => {
  const environment = process.env['VIVA_ENVIRONMENT'] ?? 'demo';

  res.setHeader('Cache-Control', 'no-store');
  res.status(200).json({
    ok: true,
    environment,
    timestamp: new Date().toISOString(),
  });
};
