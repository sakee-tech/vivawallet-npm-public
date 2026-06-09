/**
 * refund.test.ts — merchant-mode refundPayment strategy branching (slice B).
 *
 * Verifies:
 *   - 'fast' + eligible scheme → FastRefundClient, no fallback.
 *   - 'fast' + 403 → VIVA_FAST_REFUND_INELIGIBLE, no fallback.
 *   - 'auto' + eligible (Visa) → FastRefundClient.
 *   - 'auto' + 403 → falls back to Standard refund.
 *   - 'auto' + ineligible scheme (Amex) → Standard refund directly.
 *   - 'standard' → BasicAuthClient.refund directly, no FastRefund call.
 *   - cardType undefined → Standard refund.
 *
 * @see docs/ENDPOINTS.md §4
 * @see docs/plans/multi-mode-v0.md §9
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { buildProvider, merchantConfig, buildCapturedRow } from './helpers.js';
import { VivaApiError } from '@sakeetech/viva-payments-core/errors';

describe('refundPayment — merchant mode (slice B)', () => {
  beforeEach(() => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  const refundInput = {
    amount: 5, // 5 EUR major = 500 minor
    data: { medusa_payment_id: 'pay_refund_001', medusa_refund_id: 'ref_001' },
  };

  function seedCapturedRow() {
    return buildCapturedRow({
      medusa_payment_id: 'pay_refund_001',
      idempotency_key: 'pay_refund_001',
      amount_minor: '1000',
      refunded_amount_minor: '0',
      raw_payload: { TransactionId: 'viva-tx-uuid-1' },
    });
  }

  it("strategy='fast' + Visa: calls FastRefund, never Standard", async () => {
    const { provider, payments, fastRefund } = buildProvider(
      merchantConfig({ refundStrategy: 'fast' }),
      [seedCapturedRow()],
    );

    await provider.refundPayment(refundInput);

    expect(fastRefund.refund).toHaveBeenCalledTimes(1);
    expect(payments.refundPayment).not.toHaveBeenCalled();
  });

  it("strategy='fast' + Viva returns 403: throws VIVA_FAST_REFUND_INELIGIBLE (no fallback)", async () => {
    const { provider, payments, fastRefund } = buildProvider(
      merchantConfig({ refundStrategy: 'fast' }),
      [seedCapturedRow()],
    );

    fastRefund.refund.mockRejectedValueOnce(
      new VivaApiError({ message: 'Forbidden', httpStatus: 403 }),
    );

    // Service wraps errors via toMedusaError → message is preserved.
    await expect(provider.refundPayment(refundInput)).rejects.toThrow(
      /Fast Refund ineligible|VIVA_FAST_REFUND_INELIGIBLE/,
    );

    // No fallback to Standard refund.
    expect(payments.refundPayment).not.toHaveBeenCalled();
  });

  it("strategy='auto' + Visa: calls FastRefund", async () => {
    const { provider, payments, fastRefund } = buildProvider(
      merchantConfig({ refundStrategy: 'auto' }),
      [seedCapturedRow()],
    );

    // retrieveTransaction default returns cardType: 'Visa'
    await provider.refundPayment(refundInput);

    expect(fastRefund.refund).toHaveBeenCalledTimes(1);
    expect(payments.refundPayment).not.toHaveBeenCalled();
  });

  it("strategy='auto' + Visa + Fast returns 403: falls back to Standard refund", async () => {
    const { provider, payments, fastRefund } = buildProvider(
      merchantConfig({ refundStrategy: 'auto' }),
      [seedCapturedRow()],
    );

    fastRefund.refund.mockRejectedValueOnce(
      new VivaApiError({ message: 'Forbidden', httpStatus: 403 }),
    );

    await provider.refundPayment(refundInput);

    expect(fastRefund.refund).toHaveBeenCalledTimes(1);
    expect(payments.refundPayment).toHaveBeenCalledTimes(1);
  });

  it("strategy='auto' + Amex: skips Fast, calls Standard directly", async () => {
    const { provider, payments, fastRefund } = buildProvider(
      merchantConfig({ refundStrategy: 'auto' }),
      [seedCapturedRow()],
    );

    // Override retrieveTransaction to return Amex.
    payments.retrieveTransaction.mockResolvedValueOnce({
      transactionId: 'tx-1',
      orderCode: 9876543210123456n,
      statusId: 'F',
      amount: 1000n,
      currencyCode: '978',
      merchantId: '11111111-1111-1111-1111-111111111111',
      parentId: null,
      insDate: '2026-05-12T00:00:00Z',
      transactionTypeId: 5,
      cardType: 'Amex',
      cardTypeId: 11,
    });

    await provider.refundPayment(refundInput);

    expect(fastRefund.refund).not.toHaveBeenCalled();
    expect(payments.refundPayment).toHaveBeenCalledTimes(1);
  });

  it("strategy='standard': calls BasicAuthClient (via Payments.refundPayment), never Fast", async () => {
    const { provider, payments, fastRefund } = buildProvider(
      merchantConfig({ refundStrategy: 'standard' }),
      [seedCapturedRow()],
    );

    await provider.refundPayment(refundInput);

    expect(fastRefund.refund).not.toHaveBeenCalled();
    expect(payments.refundPayment).toHaveBeenCalledTimes(1);
    // retrieveTransaction is also avoidable for strategy='standard', but the
    // current adapter calls it unconditionally for cardType lookup — harmless.
  });

  it('cardType undefined (no cardTypeId): routes to Standard refund', async () => {
    const { provider, payments, fastRefund } = buildProvider(
      merchantConfig({ refundStrategy: 'auto' }),
      [seedCapturedRow()],
    );

    payments.retrieveTransaction.mockResolvedValueOnce({
      transactionId: 'tx-1',
      orderCode: 9876543210123456n,
      statusId: 'F',
      amount: 1000n,
      currencyCode: '978',
      merchantId: '11111111-1111-1111-1111-111111111111',
      parentId: null,
      insDate: '2026-05-12T00:00:00Z',
      transactionTypeId: 5,
      // cardType + cardTypeId omitted
    });

    await provider.refundPayment(refundInput);

    expect(fastRefund.refund).not.toHaveBeenCalled();
    expect(payments.refundPayment).toHaveBeenCalledTimes(1);
  });
});
