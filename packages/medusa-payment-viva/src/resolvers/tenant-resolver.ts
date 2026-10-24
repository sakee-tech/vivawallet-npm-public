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
import { VivaValidationError } from '@sakeetech/viva-payments-core/errors';
import type { VivaTenantMerchant } from '../models/viva-tenant-merchant.js';

// ---------------------------------------------------------------------------
// Public cart shape (minimal interface for portability)
// ---------------------------------------------------------------------------

export interface CartLike {
  id: string;
  metadata?: Record<string, unknown> | null;
  items?: Array<{ metadata?: Record<string, unknown> | null }>;
}

// ---------------------------------------------------------------------------
// TenantResolver interface
// ---------------------------------------------------------------------------

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
  resolveTenantFromCart(cart: CartLike): Promise<{ tenantId: string }>;

  /**
   * Look up the Viva account credentials for a tenant.
   * Throws VivaValidationError if the tenant is not found.
   */
  resolveVivaAccount(tenantId: string): Promise<{
    connectedAccountId: ConnectedAccountId;
    vivaMerchantId: MerchantId;
  }>;
}

// ---------------------------------------------------------------------------
// P19: single-tenant cart invariant
// ---------------------------------------------------------------------------

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
export function assertSingleTenantCart(cart: {
  items?: Array<{ metadata?: Record<string, unknown> | null }>;
}): void {
  if (!cart.items || cart.items.length === 0) return;

  const tenantIds = new Set<string>();
  for (const item of cart.items) {
    const tenantId = item.metadata?.['tenant_id'];
    if (typeof tenantId === 'string' && tenantId.length > 0) {
      tenantIds.add(tenantId);
    }
    if (tenantIds.size >= 2) break;
  }

  if (tenantIds.size >= 2) {
    const [first, second] = [...tenantIds];
    throw new VivaValidationError({
      message:
        `Cart contains items from multiple tenants: '${first ?? ''}' and '${second ?? ''}'. ` +
        `Multi-tenant carts are not supported in v1 (plan P19). ` +
        `Each cart must contain items from a single tenant.`,
    });
  }
}

// ---------------------------------------------------------------------------
// DefaultTenantResolver
// ---------------------------------------------------------------------------

/**
 * Default resolver: reads `cart.metadata.tenant_id` (string).
 * Looks up `viva_tenant_merchant` for the Viva account credentials.
 *
 * Inject a custom TenantResolver into VivaPaymentProviderOptions to override
 * (e.g. if tenant_id is stored in an item's metadata or an external service).
 *
 * @see references/viva-docs/md/isv-partner-program.txt:61 (P5)
 */
export class DefaultTenantResolver implements TenantResolver {
  constructor(private readonly em: EntityManager) {}

  /**
   * Reads `cart.metadata.tenant_id`. Throws VivaValidationError if absent.
   *
   * @see references/viva-docs/md/isv-partner-program.txt:61 (P5)
   */
  async resolveTenantFromCart(cart: CartLike): Promise<{ tenantId: string }> {
    const tenantId = cart.metadata?.['tenant_id'];
    if (typeof tenantId !== 'string' || tenantId.trim() === '') {
      throw new VivaValidationError({
        message:
          `Cannot resolve tenant for cart '${cart.id}': ` +
          `cart.metadata.tenant_id is missing or not a string. ` +
          `Set cart.metadata.tenant_id to the tenant identifier, or ` +
          `inject a custom TenantResolver via VivaPaymentProviderOptions.`,
      });
    }
    return { tenantId: tenantId.trim() };
  }

  /**
   * Queries viva_tenant_merchant by tenant_id.
   * Throws VivaValidationError if the tenant is not found.
   *
   * @see references/viva-docs/md/isv-partner-program.txt:61 (P5 tenant→account)
   */
  async resolveVivaAccount(tenantId: string): Promise<{
    connectedAccountId: ConnectedAccountId;
    vivaMerchantId: MerchantId;
  }> {
    const repo = this.em.getRepository<VivaTenantMerchant>('VivaTenantMerchant');
    const record = await repo.findOne({ tenant_id: tenantId });

    if (!record) {
      throw new VivaValidationError({
        message:
          `Tenant '${tenantId}' is not registered in viva_tenant_merchant. ` +
          `Onboard this tenant via the ISV partner flow before accepting payments.`,
      });
    }

    return {
      connectedAccountId: record.connected_account_id as ConnectedAccountId,
      vivaMerchantId: record.viva_merchant_id as MerchantId,
    };
  }
}
