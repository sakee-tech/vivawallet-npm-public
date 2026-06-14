"use strict";
/**
 * medusa-payment-viva
 *
 * Medusa v2 payment provider module for Viva Wallet under the ISV partner
 * program. Wraps `viva-payments-core` and adapts it to Medusa's
 * AbstractPaymentProvider interface.
 *
 * @see references/viva-docs/md/payment-isv-api.txt:1 (ISV API)
 * @see references/viva-docs/md/isv-partner-program.txt:61 (ISV overview)
 */
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.VERSION = exports.default = exports.providerExport = exports.buildAuthStrategies = exports.assertSingleTenantCart = exports.DefaultTenantResolver = exports.loadConfigFromEnv = exports.VivaPaymentProvider = void 0;
var service_js_1 = require("./service.js");
Object.defineProperty(exports, "VivaPaymentProvider", { enumerable: true, get: function () { return service_js_1.VivaPaymentProvider; } });
var config_js_1 = require("./config.js");
Object.defineProperty(exports, "loadConfigFromEnv", { enumerable: true, get: function () { return config_js_1.loadConfigFromEnv; } });
var tenant_resolver_js_1 = require("./resolvers/tenant-resolver.js");
Object.defineProperty(exports, "DefaultTenantResolver", { enumerable: true, get: function () { return tenant_resolver_js_1.DefaultTenantResolver; } });
Object.defineProperty(exports, "assertSingleTenantCart", { enumerable: true, get: function () { return tenant_resolver_js_1.assertSingleTenantCart; } });
var auth_strategy_factory_js_1 = require("./resolvers/auth-strategy-factory.js");
Object.defineProperty(exports, "buildAuthStrategies", { enumerable: true, get: function () { return auth_strategy_factory_js_1.buildAuthStrategies; } });
var payment_provider_js_1 = require("./providers/payment-provider.js");
Object.defineProperty(exports, "providerExport", { enumerable: true, get: function () { return __importDefault(payment_provider_js_1).default; } });
// Default export = the Medusa ModuleProvider definition. Medusa resolves a
// payment provider registered as `resolve: '@sakeetech/medusa-payment-viva'`
// via `module.default ?? module` and reads `.services` off it — so the package
// entry MUST default-export the ModuleProvider, or boot fails with
// "moduleProviderServices is not iterable". (Regression caught by
// test/plugin/boots-in-medusa.test.ts.)
var payment_provider_js_2 = require("./providers/payment-provider.js");
Object.defineProperty(exports, "default", { enumerable: true, get: function () { return __importDefault(payment_provider_js_2).default; } });
exports.VERSION = '0.0.0';
//# sourceMappingURL=index.js.map