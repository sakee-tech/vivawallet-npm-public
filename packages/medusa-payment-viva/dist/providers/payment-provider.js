"use strict";
/**
 * providers/payment-provider.ts — Medusa v2 module provider definition.
 *
 * Exports the ModuleProvider wiring for the Viva payment provider.
 * Use `ModuleProvider(Modules.PAYMENT, { services })` per Medusa v2 docs.
 *
 * Registration in medusa-config.ts:
 *   {
 *     resolve: "medusa-payment-viva",
 *     id: "viva",
 *     options: { config: loadConfigFromEnv() }
 *   }
 *
 * @see https://docs.medusajs.com/resources/references/payment/provider#3-create-module-provider-definition-file
 * @see references/viva-docs/md/isv-partner-program.txt:104
 */
Object.defineProperty(exports, "__esModule", { value: true });
const utils_1 = require("@medusajs/framework/utils");
const service_js_1 = require("../service.js");
exports.default = (0, utils_1.ModuleProvider)(utils_1.Modules.PAYMENT, {
    services: [service_js_1.VivaPaymentProvider],
});
//# sourceMappingURL=payment-provider.js.map