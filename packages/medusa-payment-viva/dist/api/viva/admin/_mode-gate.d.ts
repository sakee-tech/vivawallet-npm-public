/**
 * _mode-gate.ts — shared 404 short-circuit for ISV-only admin routes.
 *
 * Medusa v2 uses filesystem-based route registration: every `route.ts` is
 * mounted unconditionally at boot. There is no clean hook to skip a file
 * based on plugin config. So ISV-only admin routes use a per-handler
 * short-circuit instead — when `VivaPluginConfig.mode === 'merchant'`, the
 * handler returns 404 immediately, mimicking an unmounted route.
 *
 * Config is read lazily via `loadConfigFromEnv()` so test code that swaps
 * env vars between requests sees the change.
 *
 * Slice F will add the `/sources` route which uses this same gate.
 *
 * @see docs/plans/multi-mode-v0.md §6 (mode-surface gating)
 */
import type { MedusaRequest, MedusaResponse } from '@medusajs/framework/http';
/**
 * Returns `true` and writes a 404 response when the plugin is in merchant
 * mode (or when config fails to load — fail closed). Returns `false` when
 * the route should proceed.
 *
 * Note: this also implicitly covers misconfigured deployments. If config
 * cannot be loaded, ISV-only surfaces stay closed rather than crash with a
 * 500.
 */
export declare function reject404IfNotIsv(_req: MedusaRequest, res: MedusaResponse): boolean;
//# sourceMappingURL=_mode-gate.d.ts.map