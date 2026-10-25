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
declare const _default: import("@medusajs/types").ModuleProviderExports;
export default _default;
//# sourceMappingURL=payment-provider.d.ts.map