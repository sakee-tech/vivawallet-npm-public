/**
 * LIVE — createOrder against the demo API, both modes.
 *
 * createOrder creates a real (unpaid) order on the demo merchant, so it is
 * gated behind VIVA_LIVE_MUTATIONS=1. Asserts the #9 fix: the adapter reads
 * Viva's lowercase `orderCode` back out of the response.
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
import { CURRENCY_CODES } from '../../src/types/common.js';
import type { MerchantId } from '../../src/types/common.js';
import { randomUUID } from 'node:crypto';

liveDescribe('LIVE createOrder — ISV mode', ISV_OAUTH_VARS, () => {
  it.runIf(MUTATIONS_ENABLED)(
    'creates an ISV order against the verified merchant and returns an orderCode',
    async () => {
      const payments = makeIsvPayments();
      const res = await payments.createOrder(
        {
          amount: 1399n,
          currencyCode: CURRENCY_CODES.GBP,
          isvAmount: 99n,
          sourceCode: 'Default',
          merchantTrns: 'live-suite createOrder isv',
          customerTrns: 'Live integration test — ISV order',
        },
        {
          merchantId: DEMO_ISV_MERCHANT_ID as MerchantId,
          idempotencyKey: `live-isv-order-${randomUUID()}`,
        },
      );
      // OrderCode is a bigint; a real Viva response always yields a positive one.
      expect(typeof res.orderCode).toBe('bigint');
      expect(res.orderCode).toBeGreaterThan(0n);
    },
  );
});

liveDescribe('LIVE createOrder — merchant mode', SINGLE_OAUTH_VARS, () => {
  it.runIf(MUTATIONS_ENABLED)(
    'creates a merchant order and returns an orderCode',
    async () => {
      const payments = makeMerchantPayments();
      const res = await payments.createOrder(
        {
          amount: 1399n,
          currencyCode: CURRENCY_CODES.GBP,
          merchantTrns: 'live-suite createOrder merchant',
          customerTrns: 'Live integration test — merchant order',
        },
        { idempotencyKey: `live-merchant-order-${randomUUID()}` },
      );
      expect(typeof res.orderCode).toBe('bigint');
      expect(res.orderCode).toBeGreaterThan(0n);
    },
  );
});
