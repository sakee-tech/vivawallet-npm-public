/**
 * LIVE — ISV connected accounts (POST/GET /isv/v1/accounts).
 *
 * Retrieve is read-only and runs by default. Create mints a NEW connected
 * account server-side, so it is gated behind VIVA_LIVE_MUTATIONS=1.
 */

import { it, expect } from 'vitest';
import {
  liveDescribe,
  ISV_OAUTH_VARS,
  MUTATIONS_ENABLED,
  DEMO_ISV_ACCOUNT_ID,
} from './_env.js';
import { makeIsvAccounts } from './_clients.js';
import type { ConnectedAccountId } from '../../src/types/common.js';

liveDescribe('LIVE ISV accounts — retrieve', ISV_OAUTH_VARS, () => {
  it('retrieves the persistent verified demo account', async () => {
    const accounts = makeIsvAccounts();
    const res = await accounts.retrieveConnectedAccount(
      DEMO_ISV_ACCOUNT_ID as ConnectedAccountId,
    );
    expect(res).toBeTruthy();
    // The persistent demo account is verified; merchantId is populated once
    // verified === true. If Viva ever de-verifies it, this surfaces loudly.
    expect(res.verified).toBe(true);
    expect(typeof res.merchantId).toBe('string');
  });
});

liveDescribe('LIVE ISV accounts — create', ISV_OAUTH_VARS, () => {
  it.runIf(MUTATIONS_ENABLED)(
    'creates a connected account and returns an invitation URL',
    async () => {
      const accounts = makeIsvAccounts();
      const res = await accounts.createConnectedAccount({
        email: 'live-suite+create@example.com',
        returnUrl: 'https://example.com/viva/return',
      });
      expect(res.accountId).toBeTruthy();
      expect(res.invitation?.redirectUrl).toMatch(/^https?:\/\//);
    },
  );
});
