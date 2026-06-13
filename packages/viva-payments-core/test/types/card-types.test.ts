/**
 * Unit tests for the cardTypeId → cardType string mapping.
 *
 * Mapping source: references/viva-docs/md/wh-transaction-payment-created.txt
 * (search for "CardTypeId").
 *
 * @see ../../src/types/card-types.ts
 */

import { describe, it, expect } from 'vitest';
import {
  CARD_TYPE_BY_ID,
  resolveCardType,
} from '../../src/types/card-types.js';

describe('resolveCardType', () => {
  it('maps cardTypeId 0 to "Visa" (per wh-transaction-payment-created.txt)', () => {
    expect(resolveCardType(0)).toBe('Visa');
  });

  it('maps every documented scheme id to its expected string', () => {
    // Casing matches FAST_REFUND_ELIGIBLE_SCHEMES in refunds/strategy.ts
    // (`'MasterCard'`), so resolveRefundStrategy can consume this directly.
    expect(resolveCardType(0)).toBe('Visa');
    expect(resolveCardType(1)).toBe('MasterCard');
    expect(resolveCardType(2)).toBe('Diners');
    expect(resolveCardType(3)).toBe('Amex');
    expect(resolveCardType(6)).toBe('Maestro');
    expect(resolveCardType(7)).toBe('Discover');
    expect(resolveCardType(8)).toBe('JCB');
  });

  it('returns undefined for sentinel "Invalid" (4) and "Unknown" (5)', () => {
    expect(resolveCardType(4)).toBeUndefined();
    expect(resolveCardType(5)).toBeUndefined();
  });

  it('returns undefined for null', () => {
    expect(resolveCardType(null)).toBeUndefined();
  });

  it('returns undefined for undefined', () => {
    expect(resolveCardType(undefined)).toBeUndefined();
  });

  it('returns undefined for unknown / out-of-range ids', () => {
    expect(resolveCardType(999)).toBeUndefined();
    expect(resolveCardType(-1)).toBeUndefined();
  });

  it('CARD_TYPE_BY_ID is frozen (defence against mutation)', () => {
    expect(Object.isFrozen(CARD_TYPE_BY_ID)).toBe(true);
  });
});
