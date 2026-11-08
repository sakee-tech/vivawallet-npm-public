"use strict";
/**
 * auth-strategy-factory.ts — builds AuthStrategy instances from VivaPluginConfig.
 *
 * Constructs OAuth2ClientCredentialsStrategy with:
 *   - InMemoryTokenCache + AsyncMutex (single-worker default, plan P11)
 *   - Redis lock when config.redis is provided (multi-worker, plan P11)
 *
 * Builds ResellerBasicAuthStrategy only when `config.mode === 'isv'` and
 * `config.reseller` is present (Q5 — some endpoints require reseller auth).
 *
 * @see references/viva-docs/md/oauth2-authentication.txt:119 (client_credentials)
 * @see references/viva-docs/md/payment-isv-api.txt:1 (reseller credentials)
 * @see references/viva-docs/md/isv-credentials.txt:107 (credential types)
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.buildAuthStrategies = buildAuthStrategies;
const auth_1 = require("@sakeetech/viva-payments-core/auth");
// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------
/**
 * Builds the full AuthStrategySet from the plugin config.
 *
 * Token lifecycle:
 *   - InMemoryTokenCache is always created for the in-process cache.
 *   - AsyncMutex is always created for single-flight de-duplication.
 *   - If config.redis is provided, it is passed as `redisLock` to the
 *     OAuth2 strategy which prefers the Redis distributed lock over the
 *     in-process mutex (plan P11).
 *
 * @see references/viva-docs/md/oauth2-authentication.txt:128 (token endpoint)
 * @see references/viva-docs/md/isv-credentials.txt:107 (auth strategies)
 */
function buildAuthStrategies(config) {
    const cache = new auth_1.InMemoryTokenCache();
    const mutex = new auth_1.AsyncMutex();
    const primary = new auth_1.OAuth2ClientCredentialsStrategy({
        environment: config.environment,
        clientId: config.clientId,
        clientSecret: config.clientSecret,
        cache,
        mutex,
        ...(config.redis !== undefined ? { redisLock: config.redis } : {}),
    });
    // Reseller strategy is ISV-only. Type-narrowed via discriminant.
    const resellerConfig = config.mode === 'isv' ? config.reseller : undefined;
    const reseller = resellerConfig !== undefined
        ? new auth_1.ResellerBasicAuthStrategy({
            resellerId: resellerConfig.resellerId,
            merchantId: resellerConfig.merchantId,
            resellerApiKey: resellerConfig.resellerApiKey,
        })
        : undefined;
    return {
        primary,
        ...(reseller !== undefined ? { reseller } : {}),
    };
}
//# sourceMappingURL=auth-strategy-factory.js.map