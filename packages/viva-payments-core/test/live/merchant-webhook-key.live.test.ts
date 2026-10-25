/**
 * LIVE — merchant webhook verification key (GET /api/messages/config/token,
 * legacy host, merchant Basic auth).
 *
 * Read-only; runs by default when single-merchant Basic creds are present.
 */

import { it, expect } from 'vitest';
import { liveDescribe, SINGLE_MERCHANT_BASIC_VARS } from './_env.js';
import { makeMerchantBasicClient } from './_clients.js';

liveDescribe(
  'LIVE merchant webhook key',
  SINGLE_MERCHANT_BASIC_VARS,
  () => {
    it('fetches the merchant webhook verification key', async () => {
      const client = makeMerchantBasicClient();
      const key = await client.fetchWebhookVerificationKey();
      expect(typeof key).toBe('string');
      expect(key.length).toBeGreaterThan(0);
    });
  },
);
