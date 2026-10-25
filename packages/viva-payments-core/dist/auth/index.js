"use strict";
/**
 * viva-payments-core/auth — barrel export.
 *
 * Subpath: `viva-payments-core/auth`
 *
 * Exports auth strategies, token cache types, single-flight primitives,
 * and HTTP dispatcher helpers for re-use by S3 (ISV calls).
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.closeAllDispatchers = exports.getApiDispatcher = exports.getAuthDispatcher = exports.noopRedisLock = exports.singleFlight = exports.AsyncMutex = exports.RedisTokenCache = exports.InMemoryTokenCache = exports.ResellerBasicAuthStrategy = exports.OAuth2ClientCredentialsStrategy = void 0;
// Strategies
var oauth2_strategy_js_1 = require("./oauth2-strategy.js");
Object.defineProperty(exports, "OAuth2ClientCredentialsStrategy", { enumerable: true, get: function () { return oauth2_strategy_js_1.OAuth2ClientCredentialsStrategy; } });
var reseller_strategy_js_1 = require("./reseller-strategy.js");
Object.defineProperty(exports, "ResellerBasicAuthStrategy", { enumerable: true, get: function () { return reseller_strategy_js_1.ResellerBasicAuthStrategy; } });
// Token cache
var token_cache_js_1 = require("./token-cache.js");
Object.defineProperty(exports, "InMemoryTokenCache", { enumerable: true, get: function () { return token_cache_js_1.InMemoryTokenCache; } });
Object.defineProperty(exports, "RedisTokenCache", { enumerable: true, get: function () { return token_cache_js_1.RedisTokenCache; } });
// Single-flight primitives (exposed for SaaS to wire Redis)
var single_flight_js_1 = require("./single-flight.js");
Object.defineProperty(exports, "AsyncMutex", { enumerable: true, get: function () { return single_flight_js_1.AsyncMutex; } });
Object.defineProperty(exports, "singleFlight", { enumerable: true, get: function () { return single_flight_js_1.singleFlight; } });
Object.defineProperty(exports, "noopRedisLock", { enumerable: true, get: function () { return single_flight_js_1.noopRedisLock; } });
// HTTP dispatcher (re-exported so S3 can share the same pools)
var http_js_1 = require("./http.js");
Object.defineProperty(exports, "getAuthDispatcher", { enumerable: true, get: function () { return http_js_1.getAuthDispatcher; } });
Object.defineProperty(exports, "getApiDispatcher", { enumerable: true, get: function () { return http_js_1.getApiDispatcher; } });
Object.defineProperty(exports, "closeAllDispatchers", { enumerable: true, get: function () { return http_js_1.closeAllDispatchers; } });
//# sourceMappingURL=index.js.map