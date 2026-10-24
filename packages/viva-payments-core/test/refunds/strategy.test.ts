/**
 * resolveRefundStrategy pure-function tests.
 *
 * @see docs/ENDPOINTS.md §4
 * @see docs/STATE-MACHINE.md §3.1
 * @see references/payment-api.yaml:9268
 */

import { describe, it, expect } from 'vitest';
import { resolveRefundStrategy } from '../../src/refunds/strategy.js';

describe('resolveRefundStrategy', () => {
  it("strategy='fast' → fast/configured regardless of context", () => {
    expect(resolveRefundStrategy('fast', { isCardNotPresent: true })).toEqual({
      kind: 'fast',
      reason: 'configured',
    });
    // Even with ineligible inputs, configured 'fast' wins — server enforces eligibility.
    expect(resolveRefundStrategy('fast', { isCardNotPresent: false, cardType: 'Amex' })).toEqual({
      kind: 'fast',
      reason: 'configured',
    });
    expect(resolveRefundStrategy('fast', { isCardNotPresent: true, cardType: 'JCB' })).toEqual({
      kind: 'fast',
      reason: 'configured',
    });
  });

  it("strategy='standard' → standard/configured regardless of context", () => {
    expect(resolveRefundStrategy('standard', { isCardNotPresent: true })).toEqual({
      kind: 'standard',
      reason: 'configured',
    });
    expect(
      resolveRefundStrategy('standard', { isCardNotPresent: true, cardType: 'Visa' }),
    ).toEqual({ kind: 'standard', reason: 'configured' });
    expect(
      resolveRefundStrategy('standard', { isCardNotPresent: false, cardType: 'Amex' }),
    ).toEqual({ kind: 'standard', reason: 'configured' });
  });

  it("strategy='auto' + Visa + CNP → fast/auto-eligible", () => {
    expect(
      resolveRefundStrategy('auto', { isCardNotPresent: true, cardType: 'Visa' }),
    ).toEqual({ kind: 'fast', reason: 'auto-eligible' });
  });

  it("strategy='auto' + MasterCard + CNP → fast/auto-eligible", () => {
    expect(
      resolveRefundStrategy('auto', { isCardNotPresent: true, cardType: 'MasterCard' }),
    ).toEqual({ kind: 'fast', reason: 'auto-eligible' });
  });

  it("strategy='auto' + Maestro + CNP → fast/auto-eligible", () => {
    expect(
      resolveRefundStrategy('auto', { isCardNotPresent: true, cardType: 'Maestro' }),
    ).toEqual({ kind: 'fast', reason: 'auto-eligible' });
  });

  it("strategy='auto' + Amex + CNP → standard/auto-ineligible-scheme", () => {
    expect(
      resolveRefundStrategy('auto', { isCardNotPresent: true, cardType: 'Amex' }),
    ).toEqual({ kind: 'standard', reason: 'auto-ineligible-scheme' });
  });

  it("strategy='auto' + JCB + CNP → standard/auto-ineligible-scheme", () => {
    expect(
      resolveRefundStrategy('auto', { isCardNotPresent: true, cardType: 'JCB' }),
    ).toEqual({ kind: 'standard', reason: 'auto-ineligible-scheme' });
  });

  it("strategy='auto' + Visa + card-present → standard/auto-ineligible-card-present", () => {
    expect(
      resolveRefundStrategy('auto', { isCardNotPresent: false, cardType: 'Visa' }),
    ).toEqual({ kind: 'standard', reason: 'auto-ineligible-card-present' });
  });

  it("strategy='auto' + undefined cardType + CNP → standard/auto-no-card-info", () => {
    expect(resolveRefundStrategy('auto', { isCardNotPresent: true })).toEqual({
      kind: 'standard',
      reason: 'auto-no-card-info',
    });
  });

  it("strategy='auto' is case-sensitive: 'visa' (lowercase) → standard/auto-ineligible-scheme", () => {
    expect(
      resolveRefundStrategy('auto', { isCardNotPresent: true, cardType: 'visa' }),
    ).toEqual({ kind: 'standard', reason: 'auto-ineligible-scheme' });
    expect(
      resolveRefundStrategy('auto', { isCardNotPresent: true, cardType: 'mastercard' }),
    ).toEqual({ kind: 'standard', reason: 'auto-ineligible-scheme' });
  });
});
