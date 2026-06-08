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
import { timingSafeEqual } from 'node:crypto';
import { getSharedMetrics } from '../../../../observability/index.js';

// ---------------------------------------------------------------------------
// Admin token guard (same pattern as auth-status)
// ---------------------------------------------------------------------------

function isTokenValid(provided: string, expected: string): boolean {
  if (provided.length !== expected.length) return false;
  return timingSafeEqual(Buffer.from(provided, 'utf-8'), Buffer.from(expected, 'utf-8'));
}

// ---------------------------------------------------------------------------
// GET handler
// ---------------------------------------------------------------------------

export const GET = async (
  req: MedusaRequest,
  res: MedusaResponse,
): Promise<void> => {
  const adminToken = process.env['VIVA_ADMIN_TOKEN'];

  if (!adminToken) {
    res.status(401).json({
      error: 'unauthorized',
      reason: 'admin-token-not-configured',
    });
    return;
  }

  const provided = req.headers['x-viva-admin-token'];
  const providedStr = Array.isArray(provided) ? provided[0] : provided;

  if (!providedStr || !isTokenValid(providedStr, adminToken)) {
    res.status(401).json({ error: 'unauthorized' });
    return;
  }

  const exposition = getSharedMetrics().toExposition();

  res.setHeader('Content-Type', 'text/plain; version=0.0.4; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.status(200).send(exposition);
};
