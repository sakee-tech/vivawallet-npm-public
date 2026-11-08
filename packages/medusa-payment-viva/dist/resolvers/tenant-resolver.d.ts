/**
 * tenant-resolver.ts — Cart-to-tenant resolution for multi-tenant ISV routing.
 *
 * Every payment in the ISV model must be scoped to a single Viva merchant.
 * This module resolves a Medusa cart to its tenant's Viva credentials by:
 *   1. Reading `cart.metadata.tenant_id` (default strategy) or delegating to
 *      a custom resolver injected via VivaPluginConfig.
 *   2. Looking up `viva_tenant_merchant` in the plugin DB to get
 *      `{connected_account_id, viva_merchant_id}`.
 *
 * P19 invariant: `assertSingleTenantCart` is called before any network I/O
 * to reject multi-tenant carts early (Marketplace mode is deferred, see P3).
 *
 * @see references/viva-docs/md/isv-partner-program.txt:61 (P1 merchant scoping)
 * @see references/viva-docs/md/payment-isv-api.txt:1 (merchantId query param)
 */
import type { EntityManager } from '@medusajs/framework/mikro-orm/core';
import type { ConnectedAccountId, MerchantId } from '@sakeetech/viva-payments-core/types';
export interface CartLike {
    id: string;
    metadata?: Record<string, unknown> | null;
    items?: Array<{
        metadata?: Record<string, unknown> | null;
    }>;
}
/**
 * Resolves a Medusa cart to its Viva tenant + account credentials.
 *
 * Custom implementations may inspect cart items, metadata, or an external
 * mapping service. The plugin ships `DefaultTenantResolver` which reads
 * `cart.metadata.tenant_id`.
 *
 * @see references/viva-docs/md/isv-partner-program.txt:61 (P5 tenant→account mapping)
 */
export interface TenantResolver {
    /**
     * Extract the tenant identifier from a cart.
     * Throws VivaValidationError if the tenant cannot be determined.
     */
    resolveTenantFromCart(cart: CartLike): Promise<{
        tenantId: string;
    }>;
    /**
     * Look up the Viva account credentials for a tenant.
     * Throws VivaValidationError if the tenant is not found.
     */
    resolveVivaAccount(tenantId: string): Promise<{
        connectedAccountId: ConnectedAccountId;
        vivaMerchantId: MerchantId;
    }>;
}
/**
 * Validates that a cart contains items from at most one tenant.
 *
 * Inspects each line item's `metadata.tenant_id`. If two distinct values are
 * found, throws VivaValidationError with both tenant IDs in the message.
 *
 * Rationale: Multi-seller (Marketplace) split payments are explicitly out of
 * scope for v1 (plan P3/P19). A payment must be scoped to a single merchant.
 *
 * Items without `metadata.tenant_id` are ignored here — the cart-level
 * metadata is the authoritative tenant source via `resolveTenantFromCart`.
 *
 * @throws VivaValidationError if items contain two distinct tenant_id values.
 *
 * @see references/viva-docs/md/isv-partner-program.txt:61 (P19 invariant)
 */
export declare function assertSingleTenantCart(cart: {
    items?: Array<{
        metadata?: Record<string, unknown> | null;
    }>;
}): void;
/**
 * Default resolver: reads `cart.metadata.tenant_id` (string).
 * Looks up `viva_tenant_merchant` for the Viva account credentials.
 *
 * Inject a custom TenantResolver into VivaPaymentProviderOptions to override
 * (e.g. if tenant_id is stored in an item's metadata or an external service).
 *
 * @see references/viva-docs/md/isv-partner-program.txt:61 (P5)
 */
export declare class DefaultTenantResolver implements TenantResolver {
    private readonly em;
    constructor(em: EntityManager);
    /**
     * Reads `cart.metadata.tenant_id`. Throws VivaValidationError if absent.
     *
     * @see references/viva-docs/md/isv-partner-program.txt:61 (P5)
     */
    resolveTenantFromCart(cart: CartLike): Promise<{
        tenantId: string;
    }>;
    /**
     * Queries viva_tenant_merchant by tenant_id.
     * Throws VivaValidationError if the tenant is not found.
     *
     * @see references/viva-docs/md/isv-partner-program.txt:61 (P5 tenant→account)
     */
    resolveVivaAccount(tenantId: string): Promise<{
        connectedAccountId: ConnectedAccountId;
        vivaMerchantId: MerchantId;
    }>;
}
//# sourceMappingURL=tenant-resolver.d.ts.map