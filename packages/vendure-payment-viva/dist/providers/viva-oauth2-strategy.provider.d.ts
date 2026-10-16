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
import { OAuth2ClientCredentialsStrategy } from '@sakeetech/viva-payments-core/auth';
import type { VivaPaymentPluginOptions } from '../types.js';
export { VIVA_OAUTH2_STRATEGY_TOKEN } from '../constants.js';
/**
 * Nest provider that builds and exposes the singleton OAuth2 strategy.
 *
 * The factory is intentionally simple: one set of credentials, one cache,
 * one mutex. Multi-worker scenarios can inject a `redisLock` through plugin
 * options (D12 — Redlock client).
 */
export declare const VivaOAuth2StrategyProvider: {
    provide: string;
    inject: [string];
    useFactory: (options: VivaPaymentPluginOptions) => OAuth2ClientCredentialsStrategy;
};
export type VivaOAuth2Strategy = OAuth2ClientCredentialsStrategy;
/**
 * Convenience parameter decorator for injecting the OAuth2 strategy.
 *
 * @example
 * ```ts
 * constructor(@InjectVivaOAuth2Strategy() private readonly oauth2: VivaOAuth2Strategy) {}
 * ```
 */
export declare const InjectVivaOAuth2Strategy: () => ParameterDecorator;
//# sourceMappingURL=viva-oauth2-strategy.provider.d.ts.map