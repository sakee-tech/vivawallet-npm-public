/**
 * providers/viva-oauth2-strategy.provider.ts — singleton OAuth2 strategy Nest provider.
 *
 * Builds a single `OAuth2ClientCredentialsStrategy` from the plugin options
 * and registers it under `VIVA_OAUTH2_STRATEGY_TOKEN`. All other providers that
 * need a bearer token inject this token — same stateful cache is reused across
 * every request.
 *
 * Token cache is keyed by `viva:isv:token:{clientId}:{environment}` inside the
 * strategy. Because there is only one client_id platform-wide, one InMemoryTokenCache
 * instance covers all merchants.
 *
 * @see docs/plans/vendure-plugin-v0.md §"Configuration Surface" (D12)
 * @see packages/medusa-payment-viva/src/loaders/viva-oauth2-strategy.ts (reference impl)
 */
import { Inject } from '@nestjs/common';
import { OAuth2ClientCredentialsStrategy, InMemoryTokenCache, AsyncMutex, } from '@sakeetech/viva-payments-core/auth';
import { VIVA_PLUGIN_OPTIONS, VIVA_OAUTH2_STRATEGY_TOKEN } from '../constants.js';
// ---------------------------------------------------------------------------
// Re-export the token so callers can import from a single path.
// ---------------------------------------------------------------------------
export { VIVA_OAUTH2_STRATEGY_TOKEN } from '../constants.js';
// ---------------------------------------------------------------------------
// Provider factory
// ---------------------------------------------------------------------------
/**
 * Nest provider that builds and exposes the singleton OAuth2 strategy.
 *
 * The factory is intentionally simple: one set of credentials, one cache,
 * one mutex. Multi-worker scenarios can inject a `redisLock` through plugin
 * options (D12 — Redlock client).
 */
export const VivaOAuth2StrategyProvider = {
    provide: VIVA_OAUTH2_STRATEGY_TOKEN,
    inject: [VIVA_PLUGIN_OPTIONS],
    useFactory: (options) => {
        const cache = new InMemoryTokenCache();
        const mutex = new AsyncMutex();
        return new OAuth2ClientCredentialsStrategy({
            environment: options.environment,
            clientId: options.clientId,
            clientSecret: options.clientSecret,
            cache,
            mutex,
            // Optional infra overrides from plugin options.
            ...(options.metricsHook !== undefined ? { metrics: options.metricsHook } : {}),
            ...(options.logger !== undefined ? { logger: options.logger } : {}),
        });
    },
};
/**
 * Convenience parameter decorator for injecting the OAuth2 strategy.
 *
 * @example
 * ```ts
 * constructor(@InjectVivaOAuth2Strategy() private readonly oauth2: VivaOAuth2Strategy) {}
 * ```
 */
export const InjectVivaOAuth2Strategy = () => Inject(VIVA_OAUTH2_STRATEGY_TOKEN);
//# sourceMappingURL=viva-oauth2-strategy.provider.js.map