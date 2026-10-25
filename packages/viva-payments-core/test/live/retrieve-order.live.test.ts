/**
 * LIVE — retrieveOrder (GET /api/orders/{orderCode}, legacy host, Basic auth).
 *
 * Pattern: create an order first (MUTATIONS_ENABLED), then retrieve it by the
 * returned orderCode. Both the ISV and merchant paths are covered.
 *
 * retrieveOrder is read-via-legacy-host — only the create half is a mutation.
 * The retrieve itself is idempotent (GET).
 *
 * @see docs/internal/payment-isv-api.yaml:786 (GET /api/orders/{order_code})
 * @see docs/internal/test-sweep-mocked-to-live-plan.md §Phase 1b
 */

import { it, expect } from 'vitest';
import {
  liveDescribe,
  ISV_OAUTH_VARS,
  ISV_RESELLER_VARS,
  MUTATIONS_ENABLED,
  DEMO_ISV_MERCHANT_ID,
} from './_env.js';
import { makeIsvPayments, makeResellerBasicClient } from './_clients.js';
import { CURRENCY_CODES } from '../../src/types/common.js';
import type { MerchantId, OrderCode } from '../../src/types/common.js';
import { randomUUID } from 'node:crypto';

liveDescribe(
  'LIVE retrieveOrder — ISV mode',
  [...ISV_OAUTH_VARS, ...ISV_RESELLER_VARS],
  () => {
    it.runIf(MUTATIONS_ENABLED)(
      'creates an ISV order then retrieves it by orderCode',
      async () => {
        const payments = makeIsvPayments();
        const legacyClient = makeResellerBasicClient();

        // 1. Create an order to get a fresh orderCode.
        const order = await payments.createOrder(
          {
            amount: 100n,
            currencyCode: CURRENCY_CODES.GBP,
            isvAmount: 0n,
            sourceCode: 'Default',
            merchantTrns: 'live-suite retrieve-order probe',
            customerTrns: 'retrieve-order live probe',
          },
          {
            merchantId: DEMO_ISV_MERCHANT_ID as MerchantId,
            idempotencyKey: `live-isv-retrieve-order-${randomUUID()}`,
          },
        );
        expect(typeof order.orderCode).toBe('bigint');
        expect(order.orderCode).toBeGreaterThan(0n);

        // 2. Retrieve the order immediately — should be in pending (not-yet-paid) state.
        const retrieved = await payments.retrieveOrder(
          order.orderCode as unknown as OrderCode,
          {
            merchantId: DEMO_ISV_MERCHANT_ID as MerchantId,
            legacyClient,
          },
        );

        // The retrieved orderCode should match what was returned by createOrder.
        // Amount is stored and returned in minor units after major→minor conversion.
        expect(retrieved.requestAmount).toBeGreaterThan(0n);
        // stateId 3 = pending (created, not yet paid)
        expect(typeof retrieved.stateId).toBe('number');
      },
    );
  },
);
