/**
 * Unit tests for the exponent-aware major⇄minor currency conversion.
 *
 * Pure functions — no network. Guards the asymmetry that bit #20: Viva
 * responses are MAJOR-unit decimals; we store MINOR-unit bigints.
 */

import { describe, it, expect } from 'vitest';
import { minorUnitExponent, majorToMinor } from '../../src/types/currency-exponent.js';

describe('minorUnitExponent', () => {
  it('defaults to 2 for common / unknown currencies', () => {
    expect(minorUnitExponent('978')).toBe(2); // EUR
    expect(minorUnitExponent('826')).toBe(2); // GBP
    expect(minorUnitExponent(840)).toBe(2);   // USD (numeric)
    expect(minorUnitExponent('999')).toBe(2); // unknown → default
    expect(minorUnitExponent(undefined)).toBe(2);
  });

  it('returns 0 for zero-decimal currencies', () => {
    expect(minorUnitExponent('392')).toBe(0); // JPY
    expect(minorUnitExponent(410)).toBe(0);   // KRW
    expect(minorUnitExponent('704')).toBe(0); // VND
  });

  it('returns 3 for three-decimal currencies', () => {
    expect(minorUnitExponent('048')).toBe(3); // BHD
    expect(minorUnitExponent(414)).toBe(3);   // KWD
    expect(minorUnitExponent('512')).toBe(3); // OMR
  });

  it('zero-pads 1-2 digit numeric codes', () => {
    expect(minorUnitExponent(48)).toBe(3);  // BHD as bare number → '048'
  });
});

describe('majorToMinor', () => {
  it('converts 2-decimal majors without IEEE-754 rounding error', () => {
    expect(majorToMinor(23.17, '826')).toBe(2317n); // the #20 RangeError case
    expect(majorToMinor(10.55, '978')).toBe(1055n);
    expect(majorToMinor(0.27, 978)).toBe(27n);
    expect(majorToMinor(5.0, '978')).toBe(500n);   // whole value still scales
  });

  it('does not scale zero-decimal currencies', () => {
    expect(majorToMinor(5000, '392')).toBe(5000n); // JPY ×1
  });

  it('scales three-decimal currencies by 1000', () => {
    expect(majorToMinor(1.234, '414')).toBe(1234n); // KWD
  });

  it('accepts numeric strings and bigints', () => {
    expect(majorToMinor('23.17', '826')).toBe(2317n);
    expect(majorToMinor(5n, '978')).toBe(500n);
  });

  it('coerces non-finite input to 0n rather than throwing', () => {
    expect(majorToMinor(Number.NaN, '978')).toBe(0n);
  });
});
