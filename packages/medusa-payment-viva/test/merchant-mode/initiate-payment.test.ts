/**
 * initiate-payment.test.ts — merchant-mode initiatePayment unit tests (slice B).
 *
 * Verifies:
 *   - Happy path: createOrder is called WITHOUT merchantId; redirect_url is returned.
 *   - viva_transaction row created with status='initiated' and viva_merchant_id
 *     fallback (legacyMerchantId since column is non-nullable until slice D).
 *   - Idempotency: same medusa_payment_id returns same orderCode (existing row).
 *   - merchant-mode createOrder body has no isvAmount.
 *   - ISV mode unchanged: createOrder still passes merchantId from tenant resolver.
 *
 * @see docs/plans/multi-mode-v0.md §9
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  buildProvider,
  merchantConfig,
  isvConfig,
  buildCapturedRow,
} from './helpers.js';
import type { InitiatePaymentInput } from '@medusajs/framework/types';

describe('initiatePayment — merchant mode (slice B)', () => {
  beforeEach(() => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  it('happy path: createOrder called without merchantId, returns redirect_url', async () => {
    const { provider, payments, em } = buildProvider(merchantConfig());

    const input: InitiatePaymentInput = {
      amount: 10,
      currency_code: 'EUR',
      context: { idempotency_key: 'pay_merchant_happy_001' },
      data: {},
    };

    const result = await provider.initiatePayment(input);

    expect(payments.createOrder).toHaveBeenCalledTimes(1);
    const [req, opts] = payments.createOrder.mock.calls[0];

    // No merchantId in opts (Payments would silently ignore it in merchant
    // mode, but the adapter should NOT pass it at all).
    expect(opts).not.toHaveProperty('merchantId');
    expect(opts.idempotencyKey).toBe('pay_merchant_happy_001');

    // Request body carries default sourceCode + minor-unit amount.
    expect(req.sourceCode).toBe('Default');
    expect(req.amount).toBe(1000n);

    // Result carries the demo-host redirect URL.
    expect(result.id).toBe('pay_merchant_happy_001');
    expect((result.data as Record<string, unknown>).redirect_url).toBe(
      'https://demo.vivapayments.com/web/checkout?ref=9876543210123456',
    );

    // Slice D: merchant-mode rows store viva_merchant_id = NULL (no per-cart
    // tenant). The column is nullable per Migration_20260425000004.
    expect(em.rows).toHaveLength(1);
    expect(em.rows[0].viva_merchant_id).toBeNull();
    expect(em.rows[0].status).toBe('initiated');
  });

  it('uses configured sourceCode when set', async () => {
    const { provider, payments } = buildProvider(
      merchantConfig({ sourceCode: 'MyChannel' }),
    );

    await provider.initiatePayment({
      amount: 5,
      currency_code: 'EUR',
      context: { idempotency_key: 'pay_src_001' },
      data: {},
    });

    expect(payments.createOrder.mock.calls[0][0].sourceCode).toBe('MyChannel');
  });

  it('idempotency: second call with existing authorized row returns same orderCode without new createOrder', async () => {
    const existing = buildCapturedRow({
      medusa_payment_id: 'pay_idem_001',
      idempotency_key: 'pay_idem_001',
      status: 'authorized',
      viva_order_code: '9876543210123456',
    });
    const { provider, payments } = buildProvider(merchantConfig(), [existing]);

    const result = await provider.initiatePayment({
      amount: 10,
      currency_code: 'EUR',
      context: { idempotency_key: 'pay_idem_001' },
      data: {},
    });

    expect(payments.createOrder).not.toHaveBeenCalled();
    expect(result.id).toBe('pay_idem_001');
    expect((result.data as Record<string, unknown>).order_code).toBe('9876543210123456');
  });

  it('merchant-mode createOrder body does not include isvAmount', async () => {
    const { provider, payments } = buildProvider(merchantConfig());

    await provider.initiatePayment({
      amount: 10,
      currency_code: 'EUR',
      context: { idempotency_key: 'pay_no_isv_amount' },
      data: {},
    });

    const req = payments.createOrder.mock.calls[0][0];
    expect(req).not.toHaveProperty('isvAmount');
  });

  it('ISV mode unchanged: createOrder still receives merchantId from tenant resolver', async () => {
    const { provider, payments } = buildProvider(isvConfig());

    // Inject a stub tenant resolver returning a known merchantId.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (provider as any).tenantResolver = {
      resolveTenantFromCart: async () => ({ tenantId: 'tenant-x' }),
      resolveVivaAccount: async () => ({
        connectedAccountId: 'acc-x',
        vivaMerchantId: 'isv-merchant-uuid',
      }),
    };

    await provider.initiatePayment({
      amount: 7,
      currency_code: 'EUR',
      context: { idempotency_key: 'pay_isv_check' },
      data: { cart_id: 'cart-1', metadata: { tenant_id: 'tenant-x' } },
    });

    const opts = payments.createOrder.mock.calls[0][1];
    expect(opts.merchantId).toBe('isv-merchant-uuid');
  });
});
