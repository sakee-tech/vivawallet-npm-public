/**
 * loaders/viva-oauth2-strategy.ts — registers the plugin config + OAuth2 strategy.
 *
 * Medusa v2 plugin loaders receive the global (root) container and can register
 * additional dependencies. This loader is the SINGLE place the plugin reads its
 * configuration at runtime (#21): it resolves the config once, then registers
 *
 *   - `vivaPluginConfig`     — the resolved `VivaPluginConfig`, and
 *   - `vivaOAuth2Strategy`   — the OAuth2 client-credentials strategy singleton
 *
 * on the container, so the subscriber, admin routes and mode gate resolve the
 * same shared objects from `req.scope` rather than each re-reading the env.
 * (Root-container registrations propagate to every request scope; a payment
 * provider's module-isolated container does not — see container.ts.)
 *
 * If config env vars are missing (e.g. test/CI environments that don't set
 * them), registration is skipped silently — consumers handle the absent case.
 *
 * @see references/viva-docs/md/isv-partner-program.txt:61 (P16 health endpoints)
 */
import type { MedusaContainer } from '@medusajs/framework/types';
import { VIVA_OAUTH2_STRATEGY_KEY, VIVA_PLUGIN_CONFIG_KEY } from '../container.js';
export { VIVA_OAUTH2_STRATEGY_KEY, VIVA_PLUGIN_CONFIG_KEY };
/**
 * Medusa v2 plugin loader.
 * Called once at startup with the global container.
 */
export default function vivaOAuth2StrategyLoader(container: MedusaContainer): void;
//# sourceMappingURL=viva-oauth2-strategy.d.ts.map