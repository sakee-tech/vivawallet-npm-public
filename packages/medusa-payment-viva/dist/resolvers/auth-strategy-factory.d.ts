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
import { OAuth2ClientCredentialsStrategy, ResellerBasicAuthStrategy } from '@sakeetech/viva-payments-core/auth';
import type { VivaPluginConfig } from '../config.js';
export interface AuthStrategySet {
    /** Primary OAuth2 bearer strategy — used for all standard ISV API calls. */
    primary: OAuth2ClientCredentialsStrategy;
    /**
     * Reseller basic-auth strategy — used for endpoints that require it (Q5).
     * Absent if config.mode !== 'isv' or config.reseller is not configured.
     *
     * @see references/viva-docs/md/payment-isv-api.txt:1 (reseller auth)
     */
    reseller?: ResellerBasicAuthStrategy;
}
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
export declare function buildAuthStrategies(config: VivaPluginConfig): AuthStrategySet;
//# sourceMappingURL=auth-strategy-factory.d.ts.map