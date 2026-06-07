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

export { VivaPaymentProvider } from './service.js';
export type { VivaPaymentProviderOptions } from './service.js';

export { loadConfigFromEnv } from './config.js';
export type { VivaPluginConfig } from './config.js';

export { DefaultTenantResolver, assertSingleTenantCart } from './resolvers/tenant-resolver.js';
export type { TenantResolver, CartLike } from './resolvers/tenant-resolver.js';

export { buildAuthStrategies } from './resolvers/auth-strategy-factory.js';
export type { AuthStrategySet } from './resolvers/auth-strategy-factory.js';

export { default as providerExport } from './providers/payment-provider.js';

export const VERSION = '0.0.0';
