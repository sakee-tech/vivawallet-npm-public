/**
 * event-types — ISV vs inbound-accept event sets.
 *
 * Guards the #18 fix: the ISV registration set must NOT contain 4865 (Order
 * Updated), which POST /isv/v1/webhooks rejects, while the inbound-accept set
 * V1_EVENT_TYPE_IDS must keep it (the handler still receives cancel events).
 */

import { describe, it, expect } from 'vitest';
import {
  V1_EVENT_TYPE_IDS,
  ISV_EVENT_TYPE_IDS,
} from '../../src/webhooks/event-types.js';

describe('ISV_EVENT_TYPE_IDS', () => {
  it('is exactly the five ISV-registerable events (no 4865)', () => {
    expect([...ISV_EVENT_TYPE_IDS].sort((a, b) => a - b)).toEqual([
      1796, 1797, 1798, 8193, 8194,
    ]);
  });

  it('excludes 4865 (Order Updated — not ISV-registerable)', () => {
    expect(ISV_EVENT_TYPE_IDS).not.toContain(4865 as never);
  });

  it('includes both onboarding events (8193/8194)', () => {
    expect(ISV_EVENT_TYPE_IDS).toContain(8193);
    expect(ISV_EVENT_TYPE_IDS).toContain(8194);
  });
});

describe('V1_EVENT_TYPE_IDS (inbound-accept)', () => {
  it('still includes 4865 — the handler receives Order Updated inbound', () => {
    expect(V1_EVENT_TYPE_IDS).toContain(4865);
  });

  it('is a superset of the ISV registration set', () => {
    for (const id of ISV_EVENT_TYPE_IDS) {
      expect(V1_EVENT_TYPE_IDS).toContain(id);
    }
  });
});
