/**
 * LIVE — ISV payment sources (POST /api/sources, legacy host, reseller Basic).
 *
 * Creating a source mutates the connected merchant's configuration, so this is
 * gated behind VIVA_LIVE_MUTATIONS=1. Each run registers a new source code, so
 * keep it opt-in to avoid exhausting the 1000–9999 source-code range.
 *
 * NOTE: Viva's POST /api/sources returns HTTP 200 with no body
 * (payment-isv-api.yaml:279-284). `sourceCode` is a required caller-supplied
 * input; the caller already holds it after a successful call.
 */

import { it, expect } from 'vitest';
import {
  liveDescribe,
  ISV_RESELLER_VARS,
  MUTATIONS_ENABLED,
} from './_env.js';
import { makeIsvSources } from './_clients.js';

const LIVE_ECOMMERCE_SOURCE_CODE = 4321; // fixed code for the live suite e-commerce source
const LIVE_PHYSICAL_SOURCE_CODE = 4322; // fixed code for the live suite physical source

liveDescribe('LIVE ISV sources — create e-commerce source', ISV_RESELLER_VARS, () => {
  it.runIf(MUTATIONS_ENABLED)(
    'creates an e-commerce source (resolves void — API returns no body)',
    async () => {
      const sources = makeIsvSources();
      // The call resolves to undefined; sourceCode is caller-supplied not response-derived.
      await expect(
        sources.createEcommerceSource({
          domain: 'live-suite.example.com',
          pathSuccess: '/viva/success',
          pathFail: '/viva/fail',
          name: 'live-suite e-commerce source',
          sourceCode: LIVE_ECOMMERCE_SOURCE_CODE,
        }),
      ).resolves.toBeUndefined();
    },
  );
});

liveDescribe('LIVE ISV sources — create physical source', ISV_RESELLER_VARS, () => {
  it.runIf(MUTATIONS_ENABLED)(
    'creates a physical source (resolves void — API returns no body)',
    async () => {
      const sources = makeIsvSources();
      await expect(
        sources.createPhysicalSource({
          name: 'live-suite physical source',
          sourceCode: LIVE_PHYSICAL_SOURCE_CODE,
        }),
      ).resolves.toBeUndefined();
    },
  );
});
