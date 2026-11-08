/**
 * modules/viva-config/index.ts — Medusa module that registers plugin config.
 *
 * Medusa v2 does NOT scan a plugin's `loaders/` directory (only subscribers,
 * jobs, links, workflows, policies are scanned). To get a loader running on the
 * root container we expose a proper Medusa module.
 *
 * When loaded with `definition: { __passSharedContainer: true }` in
 * medusa-config.js, Medusa registers `sharedContainer` = root Awilix container
 * inside the module's localContainer (load-internal.js:131). The loader then
 * resolves sharedContainer and registers vivaPluginConfig + vivaOAuth2Strategy
 * on the ROOT container, so request scopes (req.scope) can resolve them.
 *
 * @see docs/brain/medusa-plugin-packaging.md — module isolation & loaders/
 */

import { MedusaService } from '@medusajs/framework/utils';
import { Module } from '@medusajs/framework/utils';
import {
  OAuth2ClientCredentialsStrategy,
  InMemoryTokenCache,
  AsyncMutex,
} from '@sakeetech/viva-payments-core/auth';
import { loadConfigFromEnv } from '../../config.js';
import {
  VIVA_PLUGIN_CONFIG_KEY,
  VIVA_OAUTH2_STRATEGY_KEY,
} from '../../container.js';

export const VIVA_CONFIG_MODULE = 'vivaConfigService';

/** Minimal service — no models, exists only so Module() has a valid service. */
class VivaConfigService extends MedusaService({}) {}

/**
 * Module loader: registers vivaPluginConfig + vivaOAuth2Strategy on the
 * Medusa app (root) container so request scopes (req.scope) can resolve them.
 *
 * MedusaApp_ wraps the root framework container in a child scope
 * (`createMedusaContainer({}, sharedContainer)`). If we registered on that
 * child, `getContainer()` (which returns the root) couldn't see it — Awilix
 * resolution only flows upward (child → parent), never downward.
 *
 * Fix: import the framework `container` singleton directly. It IS the root
 * container that loaders/index.js exports as `{ container }` and that the
 * test runner's `getContainer()` returns.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function vivaConfigLoader(_opts: { container: any }): Promise<void> {
  // The framework singleton IS the root Awilix container.
  // We bypass the localContainer / sharedContainer scoping entirely and
  // register straight on the root so `getContainer().resolve(...)` works.
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { container: rootContainer } = require('@medusajs/framework') as {
    container: { register: (pair: Record<string, unknown>) => void };
  };

  try {
    const config = loadConfigFromEnv(process.env);
    const cache = new InMemoryTokenCache();
    const mutex = new AsyncMutex();
    const strategy = new OAuth2ClientCredentialsStrategy({
      environment: config.environment,
      clientId: config.clientId,
      clientSecret: config.clientSecret,
      cache,
      mutex,
      ...(config.redis !== undefined ? { redisLock: config.redis } : {}),
    });

    rootContainer.register({
      [VIVA_PLUGIN_CONFIG_KEY]: {
        resolve: () => config,
        lifetime: 'SINGLETON',
      },
      [VIVA_OAUTH2_STRATEGY_KEY]: {
        resolve: () => strategy,
        lifetime: 'SINGLETON',
      },
    });
  } catch {
    // Config env vars not available (test / CI). Consumers fall back gracefully
    // via resolveVivaConfig() which passes allowUnregistered: true.
  }
}

export default Module(VIVA_CONFIG_MODULE, {
  service: VivaConfigService,
  loaders: [vivaConfigLoader],
});
