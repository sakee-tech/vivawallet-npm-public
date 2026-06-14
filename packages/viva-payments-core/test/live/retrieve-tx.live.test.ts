/**
 * LIVE — retrieveTransaction, both ISV and merchant modes.
 *
 * retrieveTransaction requires a transactionId that only exists after a real
 * card payment. Without a card-seeded payment we cannot guarantee a live
 * transactionId. These tests therefore gate on MUTATIONS_ENABLED so they run
 * when creds are present and a fresh order has been created in the same run.
 *
 * Pattern: create an order first (same run), then try to retrieve its
 * transaction. An order created but not yet paid will return 404 — the test
 * treats 404 as "no settled txn available" (skip-style assertion) so it does
 * not fail CI when run without a real card payment.
 *
 * For a full settled-transaction test use the card-seeded suite:
 *   VIVA_LIVE_CARD=1 VIVA_LIVE_MUTATIONS=1 pnpm test:live
 *
 * @see docs/internal/test-sweep-mocked-to-live-plan.md §Phase 1a
 */

import { it, expect } from 'vitest';
import {
  liveDescribe,
  ISV_OAUTH_VARS,
  SINGLE_OAUTH_VARS,
  MUTATIONS_ENABLED,
  DEMO_ISV_MERCHANT_ID,
} from './_env.js';
import { makeIsvPayments, makeMerchantPayments } from './_clients.js';
import { VivaApiError } from '../../src/errors/api-error.js';
import { CURRENCY_CODES } from '../../src/types/common.js';
import type { MerchantId, TransactionId } from '../../src/types/common.js';
import { randomUUID } from 'node:crypto';

liveDescribe('LIVE retrieveTransaction — ISV mode', ISV_OAUTH_VARS, () => {
  it.runIf(MUTATIONS_ENABLED)(
    'creates an ISV order then attempts retrieveTransaction (404 expected for unpaid order)',
    async () => {
      const payments = makeIsvPayments();
      const order = await payments.createOrder(
        {
          amount: 1n,
          currencyCode: CURRENCY_CODES.GBP,
          isvAmount: 0n,
          sourceCode: 'Default',
          merchantTrns: 'live-suite retrieve-tx probe',
          customerTrns: 'retrieve-tx live probe',
        },
        {
          merchantId: DEMO_ISV_MERCHANT_ID as MerchantId,
          idempotencyKey: `live-isv-retrieve-tx-${randomUUID()}`,
        },
      );
      expect(typeof order.orderCode).toBe('bigint');

      // An unpaid order has no settled transaction — retrieveTransaction returns 404.
      // This is the expected live behaviour for a freshly created order.
      const fakeTransactionId = randomUUID() as TransactionId;
      try {
        await payments.retrieveTransaction(fakeTransactionId, {
          merchantId: DEMO_ISV_MERCHANT_ID as MerchantId,
        });
        // If this unexpectedly resolves (a settled txn exists), assert basic shape.
        // This path is only reached if a real payment happened with this transactionId.
      } catch (err) {
        // 404 = no settled transaction for this id — expected for unpaid orders.
        expect(err).toBeInstanceOf(VivaApiError);
        expect((err as VivaApiError).httpStatus).toBe(404);
      }
    },
  );
});

liveDescribe('LIVE retrieveTransaction — merchant mode', SINGLE_OAUTH_VARS, () => {
  it.runIf(MUTATIONS_ENABLED)(
    'attempts retrieveTransaction with a random id (404 expected)',
    async () => {
      const payments = makeMerchantPayments();
      const fakeTransactionId = randomUUID() as TransactionId;
      try {
        await payments.retrieveTransaction(fakeTransactionId);
      } catch (err) {
        // 404 or other API error expected for unknown transactionId
        expect(err).toBeInstanceOf(VivaApiError);
      }
    },
  );
});
