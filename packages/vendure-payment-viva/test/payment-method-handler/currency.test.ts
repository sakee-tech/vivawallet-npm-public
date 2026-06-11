/**
 * test/payment-method-handler/currency.test.ts
 *
 * Tests alphaToNumeric / numericToAlpha / coerceCurrencyCode.
 */

import { describe, it, expect } from 'vitest';
import { alphaToNumeric, numericToAlpha, coerceCurrencyCode } from '../../src/util/currency.js';

describe('alphaToNumeric', () => {
  it('GBP → 826', () => {
    expect(alphaToNumeric('GBP')).toBe('826');
  });

  it('EUR → 978', () => {
    expect(alphaToNumeric('EUR')).toBe('978');
  });

  it('USD → 840', () => {
    expect(alphaToNumeric('USD')).toBe('840');
  });

  it('case-insensitive: gbp → 826', () => {
    expect(alphaToNumeric('gbp')).toBe('826');
  });

  it('unknown code throws', () => {
    expect(() => alphaToNumeric('XXX')).toThrow('XXX');
  });
});

describe('numericToAlpha', () => {
  it('826 → GBP', () => {
    expect(numericToAlpha('826')).toBe('GBP');
  });

  it('978 → EUR', () => {
    expect(numericToAlpha('978')).toBe('EUR');
  });

  it('number input coerced: 826 → GBP', () => {
    expect(numericToAlpha(826)).toBe('GBP');
  });

  it('unknown code throws', () => {
    expect(() => numericToAlpha('999')).toThrow('999');
  });
});

describe('coerceCurrencyCode', () => {
  it('string "826" → CurrencyCode branded as "826"', () => {
    expect(coerceCurrencyCode('826')).toBe('826');
  });

  it('number 978 → CurrencyCode branded as "978"', () => {
    expect(coerceCurrencyCode(978)).toBe('978');
  });

  it('unknown throws', () => {
    expect(() => coerceCurrencyCode('001')).toThrow();
  });
});
