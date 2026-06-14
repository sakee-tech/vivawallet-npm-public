/**
 * LIVE — ISV cancelOrder against real demo Viva (NO card / NO Playwright).
 *
 * Cancel does not require a paid transaction: it mints a fresh UNPAID ISV order
 * and voids it via the legacy host (DELETE /api/orders/{oc}) with the reseller
 * 3-part Basic credential (the v2/OAuth2 route 404s). So unlike the card suite
 * this needs no Smart-Checkout payment — only `VIVA_LIVE_MUTATIONS=1` + creds.
 *
 * Why this exists separately from card/retrieve-refund-cancel.live.test.ts:
 *   that file gates the cancel case behind a Playwright card-seed it does not
 *   actually need. This file isolates the cancel + idempotency proof so it runs
 *   without Playwright.
 *
 * What it proves for the adapter cancel flow (#16/#26/#27):
 *   the handler/resolver self-heal re-voids the Viva order on a diverged row and
 *   tolerates a second void — both of which depend on cancelOrder being (a) a
 *   real success against this demo merchant and (b) IDEMPOTENT (re-cancel = 200,
 *   not 4xx). Asserted here against live Viva.
 */

import { describe, it, expect } from 'vitest';
import {
  MUTATIONS_ENABLED,
  ISV_OAUTH_VARS,
  ISV_RESELLER_VARS,
  DEMO_ISV_MERCHANT_ID,
  hasAll,
} from './_env.js';
import { makeIsvPayments, makeResellerBasicClient } from './_clients.js';
import { CURRENCY_CODES } from '../../src/types/common.js';
import type { MerchantId, OrderCode } from '../../src/types/common.js';
import { randomUUID } from 'node:crypto';

const gateOpen = MUTATIONS_ENABLED && hasAll(...ISV_OAUTH_VARS, ...ISV_RESELLER_VARS);

describe.skipIf(!gateOpen)('LIVE — ISV cancelOrder (fresh unpaid order, no Playwright)', () => {
  it('voids a fresh order via legacy /api/orders + reseller Basic, and is idempotent', async () => {
    const payments = makeIsvPayments();

    // 1. Mint a fresh, unpaid ISV order.
    const order = await payments.createOrder(
      {
        amount: 500n,
        currencyCode: CURRENCY_CODES.GBP,
        sourceCode: 'Default',
        merchantTrns: 'live cancel-order (no-card) idempotency proof',
      },
      {
        merchantId: DEMO_ISV_MERCHANT_ID as MerchantId,
        idempotencyKey: `live-cancel-noplaywright-${randomUUID()}`,
      },
    );
    expect(order.orderCode).toBeTruthy();

    // 2. First cancel → real 200 Success.
    const res = await payments.cancelOrder(order.orderCode as OrderCode, {
      merchantId: DEMO_ISV_MERCHANT_ID as MerchantId,
      legacyClient: makeResellerBasicClient(),
    });
    expect(res.errorCode).toBe(0);
    // The legacy host's BasicAuthClient parses with plain JSON.parse, so the
    // cancel response orderCode comes back as a number while createOrder returns
    // a bigint — compare by value, not by type/identity.
    expect(String(res.orderCode)).toBe(String(order.orderCode));

    // 3. Second cancel of the SAME order → still 200 Success (idempotent). This
    //    is the property the cancel self-heal relies on: re-voiding an already
    //    -voided order must not 4xx.
    const again = await payments.cancelOrder(order.orderCode as OrderCode, {
      merchantId: DEMO_ISV_MERCHANT_ID as MerchantId,
      legacyClient: makeResellerBasicClient(),
    });
    expect(again.errorCode).toBe(0);
  });
});
