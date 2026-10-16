/**
 * get-payment-status.test.ts — merchant-mode getPaymentStatus mapping (slice B).
 *
 * Verifies VivaTransactionStatus → Medusa PaymentSessionStatus mapping:
 *   - initiated → pending
 *   - authorized → authorized
 *   - captured → authorized (Medusa lacks 'captured' from session perspective)
 *   - cancelled → canceled
 *   - disputed → requires_more
 *
 * @see docs/STATE-MACHINE.md §4.2
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { buildProvider, merchantConfig, buildCapturedRow } from './helpers.js';
import type { VivaTransactionStatus } from '../../src/models/viva-transaction.js';

describe('getPaymentStatus — merchant mode (slice B)', () => {
  beforeEach(() => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  const cases: Array<[VivaTransactionStatus, string]> = [
    ['initiated', 'pending'],
    ['authorized', 'authorized'],
    ['captured', 'authorized'],
    ['cancelled', 'canceled'],
    ['disputed', 'requires_more'],
  ];

  for (const [vivaStatus, medusaStatus] of cases) {
    it(`maps ${vivaStatus} → ${medusaStatus}`, async () => {
      const row = buildCapturedRow({
        medusa_payment_id: `pay_status_${vivaStatus}`,
        status: vivaStatus,
      });
      const { provider } = buildProvider(merchantConfig(), [row]);

      const result = await provider.getPaymentStatus({
        data: { medusa_payment_id: `pay_status_${vivaStatus}` },
      });

      expect(result.status).toBe(medusaStatus);
    });
  }
});
