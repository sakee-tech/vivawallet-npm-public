/**
 * resolvers/tenant-resolver.test.ts — unit tests for TenantResolver and assertSingleTenantCart.
 *
 * No DB, no network. Tests the pure logic and DefaultTenantResolver stub.
 */

import { describe, it, expect, vi } from 'vitest';
import {
  assertSingleTenantCart,
  DefaultTenantResolver,
} from '../../src/resolvers/tenant-resolver.js';
import { VivaValidationError } from '@sakeetech/viva-payments-core/errors';

// ---------------------------------------------------------------------------
// assertSingleTenantCart
// ---------------------------------------------------------------------------

describe('assertSingleTenantCart', () => {
  it('passes for a single-tenant cart (items share the same tenant_id)', () => {
    expect(() =>
      assertSingleTenantCart({
        items: [
          { metadata: { tenant_id: 'tenant-a' } },
          { metadata: { tenant_id: 'tenant-a' } },
        ],
      }),
    ).not.toThrow();
  });

  it('throws VivaValidationError for a two-tenant cart', () => {
    expect(() =>
      assertSingleTenantCart({
        items: [
          { metadata: { tenant_id: 'tenant-a' } },
          { metadata: { tenant_id: 'tenant-b' } },
        ],
      }),
    ).toThrow(VivaValidationError);
  });

  it('includes both tenant ids in the error message', () => {
    let thrown: VivaValidationError | undefined;
    try {
      assertSingleTenantCart({
        items: [
          { metadata: { tenant_id: 'tenant-alpha' } },
          { metadata: { tenant_id: 'tenant-beta' } },
        ],
      });
    } catch (e) {
      thrown = e as VivaValidationError;
    }
    expect(thrown).toBeInstanceOf(VivaValidationError);
    expect(thrown?.message).toContain('tenant-alpha');
    expect(thrown?.message).toContain('tenant-beta');
  });

  it('does NOT throw for empty items array', () => {
    expect(() => assertSingleTenantCart({ items: [] })).not.toThrow();
  });

  it('does NOT throw when items is undefined', () => {
    expect(() => assertSingleTenantCart({})).not.toThrow();
  });

  it('does NOT throw when all items have no tenant_id in metadata', () => {
    expect(() =>
      assertSingleTenantCart({
        items: [
          { metadata: { foo: 'bar' } },
          { metadata: null },
          {},
        ],
      }),
    ).not.toThrow();
  });

  it('does NOT throw for a single item with a tenant_id', () => {
    expect(() =>
      assertSingleTenantCart({
        items: [{ metadata: { tenant_id: 'tenant-a' } }],
      }),
    ).not.toThrow();
  });

  it('ignores items without tenant_id even when mixed with tenant_id items', () => {
    // One item has tenant_id, others don't — should NOT throw
    expect(() =>
      assertSingleTenantCart({
        items: [
          { metadata: { tenant_id: 'tenant-a' } },
          { metadata: null },
          {},
          { metadata: { other: 'data' } },
        ],
      }),
    ).not.toThrow();
  });

  it('does NOT throw for three items all with the same tenant_id', () => {
    expect(() =>
      assertSingleTenantCart({
        items: [
          { metadata: { tenant_id: 'tenant-x' } },
          { metadata: { tenant_id: 'tenant-x' } },
          { metadata: { tenant_id: 'tenant-x' } },
        ],
      }),
    ).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// DefaultTenantResolver
// ---------------------------------------------------------------------------

describe('DefaultTenantResolver', () => {
  function buildResolver(findOneResult: unknown) {
    const mockEm = {
      getRepository: vi.fn().mockReturnValue({
        findOne: vi.fn().mockResolvedValue(findOneResult),
      }),
    };
    const resolver = new DefaultTenantResolver(mockEm as unknown as import('@medusajs/framework/mikro-orm/core').EntityManager);
    return { resolver, mockEm };
  }

  describe('resolveTenantFromCart', () => {
    it('returns tenantId from cart.metadata.tenant_id', async () => {
      const { resolver } = buildResolver(null);
      const result = await resolver.resolveTenantFromCart({
        id: 'cart-1',
        metadata: { tenant_id: 'tenant-abc' },
      });
      expect(result.tenantId).toBe('tenant-abc');
    });

    it('throws VivaValidationError when tenant_id is missing', async () => {
      const { resolver } = buildResolver(null);
      await expect(
        resolver.resolveTenantFromCart({ id: 'cart-1', metadata: {} }),
      ).rejects.toBeInstanceOf(VivaValidationError);
    });

    it('throws VivaValidationError when metadata is null', async () => {
      const { resolver } = buildResolver(null);
      await expect(
        resolver.resolveTenantFromCart({ id: 'cart-1', metadata: null }),
      ).rejects.toBeInstanceOf(VivaValidationError);
    });

    it('throws VivaValidationError when tenant_id is empty string', async () => {
      const { resolver } = buildResolver(null);
      await expect(
        resolver.resolveTenantFromCart({ id: 'cart-1', metadata: { tenant_id: '   ' } }),
      ).rejects.toBeInstanceOf(VivaValidationError);
    });
  });

  describe('resolveVivaAccount', () => {
    it('returns connectedAccountId and vivaMerchantId from DB', async () => {
      const { resolver } = buildResolver({
        tenant_id: 'tenant-abc',
        connected_account_id: 'conn-123',
        viva_merchant_id: 'merch-456',
      });
      const result = await resolver.resolveVivaAccount('tenant-abc');
      expect(result.connectedAccountId).toBe('conn-123');
      expect(result.vivaMerchantId).toBe('merch-456');
    });

    it('throws VivaValidationError when tenant not found in DB', async () => {
      const { resolver } = buildResolver(null);
      await expect(
        resolver.resolveVivaAccount('unknown-tenant'),
      ).rejects.toBeInstanceOf(VivaValidationError);
    });

    it('error message contains the tenant id when not found', async () => {
      const { resolver } = buildResolver(null);
      await expect(
        resolver.resolveVivaAccount('missing-tenant-99'),
      ).rejects.toThrow(/missing-tenant-99/);
    });
  });
});
