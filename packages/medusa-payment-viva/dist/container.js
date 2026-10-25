"use strict";
/**
 * container.ts — shared container registration keys + resolvers.
 *
 * #21: the plugin's runtime (loader, subscriber, admin routes, mode gate) must
 * NOT read `process.env` directly. Instead the **loader** resolves the plugin
 * config once and registers it on the (root) Medusa container under
 * `VIVA_PLUGIN_CONFIG_KEY`; everything else resolves that single shared object
 * from the request scope (`req.scope`) or the container handed to subscribers.
 *
 * Why the loader and not the payment provider: Medusa v2 enforces module
 * isolation. A payment provider lives in the Payment module's *isolated*
 * container, and registrations made there are NOT visible to `req.scope`
 * (verified empirically — a sibling scope resolves them as `undefined`). Only
 * the plugin loader runs on the root container, whose registrations DO
 * propagate down to every request scope. Medusa does not hand a plugin loader
 * the payment-provider `options`, so the loader is the one place a single env
 * read is unavoidable; `loadConfigFromEnv` is otherwise confined to the CLI.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.VIVA_OAUTH2_STRATEGY_KEY = exports.VIVA_PLUGIN_CONFIG_KEY = void 0;
exports.resolveVivaConfig = resolveVivaConfig;
/** Container key: the resolved `VivaPluginConfig`, registered by the loader. */
exports.VIVA_PLUGIN_CONFIG_KEY = 'vivaPluginConfig';
/** Container key: the shared OAuth2 strategy singleton, registered by the loader. */
exports.VIVA_OAUTH2_STRATEGY_KEY = 'vivaOAuth2Strategy';
/**
 * Resolve the plugin config from a container/request scope.
 *
 * Returns `undefined` when the loader has not registered it (e.g. a bare test
 * scope or a boot where config env was absent). Callers MUST handle the absent
 * case — admin routes and the mode gate fail closed, the subscriber skips.
 */
function resolveVivaConfig(scope) {
    if (!scope)
        return undefined;
    return scope.resolve(exports.VIVA_PLUGIN_CONFIG_KEY, {
        allowUnregistered: true,
    });
}
//# sourceMappingURL=container.js.map