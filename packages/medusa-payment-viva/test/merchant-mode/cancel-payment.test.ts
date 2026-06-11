/**
 * cancel-payment.test.ts — merchant-mode cancelPayment unit tests (slice B).
 *
 * Verifies:
 *   - Cancel calls Payments.cancelOrder with no merchantId in opts.
 *   - Cancel sets viva_transaction.status='cancelled'.
 *   - Cancel on already-cancelled row is a no-op (idempotent).
 *
 * @see docs/plans/multi-mode-v0.md §9
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { buildProvider, merchantConfig, buildCapturedRow } from './helpers.js';

describe('cancelPayment — merchant mode (slice B)', () => {
  beforeEach(() => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  it('calls Payments.cancelOrder without merchantId in opts', async () => {
    const row = buildCapturedRow({
      medusa_payment_id: 'pay_cancel_001',
      status: 'authorized',
      viva_order_code: '1234567890',
    });
    const { provider, payments } = buildProvider(merchantConfig(), [row]);

    await provider.cancelPayment({
      data: { medusa_payment_id: 'pay_cancel_001' },
    });

    expect(payments.cancelOrder).toHaveBeenCalledTimes(1);
    const [orderCode, opts] = payments.cancelOrder.mock.calls[0];
    expect(orderCode).toBe(1234567890n);
    // Merchant mode → no merchantId.
    expect(opts).not.toHaveProperty('merchantId');
  });

  it("sets viva_transaction.status='cancelled' after cancel", async () => {
    const row = buildCapturedRow({
      medusa_payment_id: 'pay_cancel_002',
      status: 'authorized',
    });
    const { provider } = buildProvider(merchantConfig(), [row]);

    await provider.cancelPayment({
      data: { medusa_payment_id: 'pay_cancel_002' },
    });

    expect(row.status).toBe('cancelled');
  });

  it('cancel on already-cancelled row is a no-op (does not call Viva)', async () => {
    const row = buildCapturedRow({
      medusa_payment_id: 'pay_cancel_003',
      status: 'cancelled',
    });
    const { provider, payments } = buildProvider(merchantConfig(), [row]);

    const result = await provider.cancelPayment({
      data: { medusa_payment_id: 'pay_cancel_003' },
    });

    expect(payments.cancelOrder).not.toHaveBeenCalled();
    expect((result.data as Record<string, unknown>).viva_status).toBe('cancelled');
  });
});
