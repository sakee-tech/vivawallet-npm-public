"use strict";
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
Object.defineProperty(exports, "__esModule", { value: true });
exports.InjectVivaOAuth2Strategy = exports.VivaOAuth2StrategyProvider = exports.VIVA_OAUTH2_STRATEGY_TOKEN = void 0;
const common_1 = require("@nestjs/common");
const auth_1 = require("@sakeetech/viva-payments-core/auth");
const constants_js_1 = require("../constants.js");
// ---------------------------------------------------------------------------
// Re-export the token so callers can import from a single path.
// ---------------------------------------------------------------------------
var constants_js_2 = require("../constants.js");
Object.defineProperty(exports, "VIVA_OAUTH2_STRATEGY_TOKEN", { enumerable: true, get: function () { return constants_js_2.VIVA_OAUTH2_STRATEGY_TOKEN; } });
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
exports.VivaOAuth2StrategyProvider = {
    provide: constants_js_1.VIVA_OAUTH2_STRATEGY_TOKEN,
    inject: [constants_js_1.VIVA_PLUGIN_OPTIONS],
    useFactory: (options) => {
        const cache = new auth_1.InMemoryTokenCache();
        const mutex = new auth_1.AsyncMutex();
        return new auth_1.OAuth2ClientCredentialsStrategy({
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
const InjectVivaOAuth2Strategy = () => (0, common_1.Inject)(constants_js_1.VIVA_OAUTH2_STRATEGY_TOKEN);
exports.InjectVivaOAuth2Strategy = InjectVivaOAuth2Strategy;
//# sourceMappingURL=viva-oauth2-strategy.provider.js.map