"use strict";
/**
 * loaders/viva-oauth2-strategy.ts — registers the OAuth2 strategy singleton.
 *
 * Medusa v2 plugin loaders receive the global container and can register
 * additional dependencies. This loader builds the primary
 * OAuth2ClientCredentialsStrategy once from env config and registers it under
 * the key `vivaOAuth2Strategy` so that route handlers (e.g. auth-status) can
 * resolve the same stateful instance that the payment provider uses.
 *
 * Registration key: `vivaOAuth2Strategy`
 *
 * @see references/viva-docs/md/isv-partner-program.txt:61 (P16 health endpoints)
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.VIVA_OAUTH2_STRATEGY_KEY = void 0;
exports.default = vivaOAuth2StrategyLoader;
const auth_1 = require("@sakeetech/viva-payments-core/auth");
const config_js_1 = require("../config.js");
exports.VIVA_OAUTH2_STRATEGY_KEY = 'vivaOAuth2Strategy';
/**
 * Medusa v2 plugin loader.
 * Called once at startup with the global container.
 * Registers the OAuth2 strategy singleton under `vivaOAuth2Strategy`.
 *
 * If config env vars are missing (e.g. in test environments that don't set
 * them), the registration is skipped silently — route handlers must handle
 * the absent-key case.
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
        // Register the singleton using the Awilix NameAndRegistrationPair form.
        // `asValue` shape: { resolve: () => T, lifetime: 'SINGLETON' }.
        // Cast through unknown to satisfy the strict MedusaContainer overload.
        container.register({
            [exports.VIVA_OAUTH2_STRATEGY_KEY]: {
                resolve: () => strategy,
                lifetime: 'SINGLETON',
            },
        });
    }
    catch {
        // Config not available (e.g. in test or CI without env vars).
        // The route falls back gracefully.
    }
}
//# sourceMappingURL=viva-oauth2-strategy.js.map