"use strict";
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
Object.defineProperty(exports, "__esModule", { value: true });
exports.VIVA_PLUGIN_CONFIG_KEY = exports.VIVA_OAUTH2_STRATEGY_KEY = void 0;
exports.default = vivaOAuth2StrategyLoader;
const auth_1 = require("@sakeetech/viva-payments-core/auth");
const config_js_1 = require("../config.js");
const container_js_1 = require("../container.js");
Object.defineProperty(exports, "VIVA_OAUTH2_STRATEGY_KEY", { enumerable: true, get: function () { return container_js_1.VIVA_OAUTH2_STRATEGY_KEY; } });
Object.defineProperty(exports, "VIVA_PLUGIN_CONFIG_KEY", { enumerable: true, get: function () { return container_js_1.VIVA_PLUGIN_CONFIG_KEY; } });
/**
 * Medusa v2 plugin loader.
 * Called once at startup with the global container.
 */
function vivaOAuth2StrategyLoader(container) {
    try {
        const config = (0, config_js_1.loadConfigFromEnv)(process.env);
        const cache = new auth_1.InMemoryTokenCache();
        const mutex = new auth_1.AsyncMutex();
        const strategy = new auth_1.OAuth2ClientCredentialsStrategy({
            environment: config.environment,
            clientId: config.clientId,
            clientSecret: config.clientSecret,
            cache,
            mutex,
            ...(config.redis !== undefined ? { redisLock: config.redis } : {}),
        });
        // Register both the config and the strategy singleton using the Awilix
        // NameAndRegistrationPair form. `asValue` shape: { resolve: () => T,
        // lifetime: 'SINGLETON' }. Cast through unknown to satisfy the strict
        // MedusaContainer overload.
        container.register({
            [container_js_1.VIVA_PLUGIN_CONFIG_KEY]: {
                resolve: () => config,
                lifetime: 'SINGLETON',
            },
            [container_js_1.VIVA_OAUTH2_STRATEGY_KEY]: {
                resolve: () => strategy,
                lifetime: 'SINGLETON',
            },
        });
    }
    catch {
        // Config not available (e.g. in test or CI without env vars).
        // Consumers resolve the keys with allowUnregistered and fall back gracefully.
    }
}
//# sourceMappingURL=viva-oauth2-strategy.js.map