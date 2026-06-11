/**
 * LIVE — ISV payment sources (POST /api/sources, legacy host, reseller Basic).
 *
 * Creating a source mutates the connected merchant's configuration, so this is
 * gated behind VIVA_LIVE_MUTATIONS=1. Each run registers a new source code, so
 * keep it opt-in to avoid exhausting the 1000–9999 source-code range.
 */

import { it, expect } from 'vitest';
import {
  liveDescribe,
  ISV_RESELLER_VARS,
  MUTATIONS_ENABLED,
} from './_env.js';
import { makeIsvSources } from './_clients.js';

liveDescribe('LIVE ISV sources — create e-commerce source', ISV_RESELLER_VARS, () => {
  it.runIf(MUTATIONS_ENABLED)(
    'creates an e-commerce source and returns a sourceCode',
    async () => {
      const sources = makeIsvSources();
      const res = await sources.createEcommerceSource({
        domain: 'live-suite.example.com',
        pathSuccess: '/viva/success',
        pathFail: '/viva/fail',
        name: 'live-suite e-commerce source',
      });
      expect(typeof res.sourceCode).toBe('number');
      expect(res.sourceCode).toBeGreaterThanOrEqual(1000);
    },
  );
});
