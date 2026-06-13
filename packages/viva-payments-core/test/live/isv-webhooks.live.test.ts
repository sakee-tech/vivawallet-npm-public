/**
 * LIVE — ISV webhooks API (/isv/v1/webhooks, /isv/v1/webhooks/token).
 *
 * getVerificationKey is read-only and runs by default. registerWebhook mutates
 * the ISV account's webhook registrations, so it is gated behind
 * VIVA_LIVE_MUTATIONS=1.
 */

import { it, expect } from 'vitest';
import { liveDescribe, ISV_OAUTH_VARS, MUTATIONS_ENABLED } from './_env.js';
import { makeIsvWebhooks } from './_clients.js';
import { EVENT_TYPES } from '../../src/types/webhook-events.js';

liveDescribe('LIVE ISV webhooks — verification key', ISV_OAUTH_VARS, () => {
  it('fetches the ISV webhook verification key', async () => {
    const webhooks = makeIsvWebhooks();
    const res = await webhooks.getVerificationKey();
    expect(typeof res.key).toBe('string');
    expect(res.key.length).toBeGreaterThan(0);
  });
});

liveDescribe('LIVE ISV webhooks — register', ISV_OAUTH_VARS, () => {
  it.runIf(MUTATIONS_ENABLED)(
    'registers a Transaction Payment Created webhook (204 No Content)',
    async () => {
      const webhooks = makeIsvWebhooks();
      // Resolves (void) on HTTP 204. A non-2xx throws VivaApiError.
      await expect(
        webhooks.registerWebhook({
          eventTypeId: EVENT_TYPES.TRANSACTION_PAYMENT_CREATED,
          url: 'https://example.com/viva/webhooks/live-suite',
        }),
      ).resolves.toBeUndefined();
    },
  );
});
