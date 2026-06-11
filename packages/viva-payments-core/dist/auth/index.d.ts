/**
 * viva-payments-core/auth — barrel export.
 *
 * Subpath: `viva-payments-core/auth`
 *
 * Exports auth strategies, token cache types, single-flight primitives,
 * and HTTP dispatcher helpers for re-use by S3 (ISV calls).
 */
export { OAuth2ClientCredentialsStrategy } from './oauth2-strategy.js';
export type { OAuth2StrategyOptions } from './oauth2-strategy.js';
export { ResellerBasicAuthStrategy } from './reseller-strategy.js';
export type { ResellerStrategyOptions } from './reseller-strategy.js';
export { InMemoryTokenCache, RedisTokenCache } from './token-cache.js';
export type { TokenCache, RedisTokenCacheClient } from './token-cache.js';
export { AsyncMutex, singleFlight, noopRedisLock } from './single-flight.js';
export type { RedisLockClient } from './single-flight.js';
export { getAuthDispatcher, getApiDispatcher, closeAllDispatchers } from './http.js';
export type { VivaHttpConfig } from './http.js';
//# sourceMappingURL=index.d.ts.map