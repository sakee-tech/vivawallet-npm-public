/**
 * LIVE — listRefunds (GET /api/transactions?ordercode=, legacy host, reseller Basic).
 *
 * READ-ONLY: lists the refunds of demo payment C (order 3445737288589019,
 * parent fab87a1a…), which holds ≥3 finished refunds from the 2026-10-24/25
 * refund-cap probes. No mutation, so no MUTATIONS_ENABLED gate.
 *
 * @see docs/brain/viva-api-endpoints.md "Refund listing"
 */

import { it, expect } from 'vitest';
import { liveDescribe, ISV_OAUTH_VARS, ISV_RESELLER_VARS } from './_env.js';
import { makeIsvPayments, makeResellerBasicClient } from './_clients.js';
import type { OrderCode, TransactionId } from '../../src/types/common.js';

liveDescribe('LIVE listRefunds — ISV reseller Basic', [...ISV_OAUTH_VARS, ...ISV_RESELLER_VARS], () => {
  it('lists ≥3 finished refunds of payment fab87a1a… on order 3445737288589019', async () => {
    const refunds = await makeIsvPayments().listRefunds(
      3445737288589019n as OrderCode,
      'fab87a1a-e4cb-463e-8f0f-a2155960fb5a' as TransactionId,
      { legacyClient: makeResellerBasicClient() },
    );
    expect(refunds.length).toBeGreaterThanOrEqual(3);
    for (const r of refunds) expect(r.amountMinor).toBeGreaterThan(0n);
  });
});
