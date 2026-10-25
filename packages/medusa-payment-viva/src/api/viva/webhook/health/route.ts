/**
 * route.ts — GET /viva/webhook/health
 *
 * Liveness probe. No auth. Returns 200 { ok: true, environment, timestamp }.
 *
 * @see references/viva-docs/md/isv-partner-program.txt:61 (P16 health endpoints)
 */

import type { MedusaRequest, MedusaResponse } from '@medusajs/framework/http';
import { resolveVivaConfig } from '../../../../container.js';

/**
 * GET /viva/webhook/health
 *
 * Returns 200 { ok: true } unconditionally.
 * Cache-Control: no-store to prevent proxy caching.
 *
 * Environment is resolved from the DI container (registered by the plugin
 * loader at boot) rather than re-reading process.env at request time (#21).
 */
export const GET = async (
  req: MedusaRequest,
  res: MedusaResponse,
): Promise<void> => {
  const config = resolveVivaConfig(req.scope);
  const environment = config?.environment ?? 'demo';

  res.setHeader('Cache-Control', 'no-store');
  res.status(200).json({
    ok: true,
    environment,
    timestamp: new Date().toISOString(),
  });
};
