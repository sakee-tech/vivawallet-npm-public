/**
 * _mode-gate.ts — shared 404 short-circuit for ISV-only admin routes.
 *
 * Medusa v2 uses filesystem-based route registration: every `route.ts` is
 * mounted unconditionally at boot. There is no clean hook to skip a file
 * based on plugin config. So ISV-only admin routes use a per-handler
 * short-circuit instead — when `VivaPluginConfig.mode === 'merchant'`, the
 * handler returns 404 immediately, mimicking an unmounted route.
 *
 * Config is resolved from the DI container (registered once by the plugin
 * loader at boot) rather than re-reading `process.env` at request time (#21).
 *
 * Slice F will add the `/sources` route which uses this same gate.
 *
 * @see docs/plans/multi-mode-v0.md §6 (mode-surface gating)
 */

import type { MedusaRequest, MedusaResponse } from '@medusajs/framework/http';
import { resolveVivaConfig } from '../../../container.js';

/**
 * Returns `true` and writes a 404 response when the plugin is in merchant
 * mode (or when config is absent — fail closed). Returns `false` when the
 * route should proceed.
 *
 * Note: this also implicitly covers misconfigured deployments. If config
 * was not registered by the loader, ISV-only surfaces stay closed rather
 * than crash with a 500.
 */
export function reject404IfNotIsv(
  req: MedusaRequest,
  res: MedusaResponse,
): boolean {
  const config = resolveVivaConfig(req.scope);
  const isIsv = config?.mode === 'isv';

  if (!isIsv) {
    res.status(404).json({ error: 'Not Found' });
    return true;
  }
  return false;
}
