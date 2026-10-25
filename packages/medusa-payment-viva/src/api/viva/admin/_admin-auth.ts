/**
 * _admin-auth.ts — shared admin-token gate for `/viva/admin/*` routes.
 *
 * Extracted in slice F so all admin routes share one timing-safe token check.
 * Behaviour is identical to the inline copies that previously lived in each
 * route file: reads `adminToken` from the DI-container-registered plugin
 * config (#21), compares it against the `x-viva-admin-token` request header
 * using `timingSafeEqual`, and writes a `401 { error: 'unauthorized' }`
 * envelope on mismatch.
 *
 * When `adminToken` is absent in the config the gate fails closed with
 * `{ error: 'unauthorized', reason: 'admin-token-not-configured' }` — same
 * envelope shape used by `/viva/internal/*` so the operator gets a clear
 * configuration hint without leaking whether a token was provided.
 *
 * @see docs/plans/multi-mode-v0.md §6 (admin REST table)
 */

import type { MedusaRequest, MedusaResponse } from '@medusajs/framework/http';
import { timingSafeEqual } from 'node:crypto';
import { resolveVivaConfig } from '../../../container.js';

function isTokenValid(provided: string, expected: string): boolean {
  if (provided.length !== expected.length) return false;
  return timingSafeEqual(
    Buffer.from(provided, 'utf-8'),
    Buffer.from(expected, 'utf-8'),
  );
}

/**
 * Returns `true` and writes a 401 response when the admin token is missing
 * or invalid. Returns `false` when the request is authorized.
 *
 * Reads `adminToken` from the plugin config registered in the DI container
 * at boot by the plugin loader (#21).
 */
export function reject401IfUnauthorized(
  req: MedusaRequest,
  res: MedusaResponse,
): boolean {
  const adminToken = resolveVivaConfig(req.scope)?.adminToken;
  if (!adminToken) {
    res
      .status(401)
      .json({ error: 'unauthorized', reason: 'admin-token-not-configured' });
    return true;
  }
  const provided = req.headers['x-viva-admin-token'];
  const providedStr = Array.isArray(provided) ? provided[0] : provided;
  if (!providedStr || !isTokenValid(providedStr, adminToken)) {
    res.status(401).json({ error: 'unauthorized' });
    return true;
  }
  return false;
}
