/**
 * redact.test.ts — redact() function unit tests.
 */

import { describe, it, expect } from 'vitest';
import { redact } from '../../src/observability/redact.js';

describe('redact()', () => {
  it('redacts CardNumber at top level', () => {
    const result = redact({ CardNumber: '4111111111111111', amount: 100 });
    expect(result).toEqual({ CardNumber: '<redacted>', amount: 100 });
  });

  it('redacts nested CardNumber', () => {
    const result = redact({
      payment: {
        CardNumber: '4111111111111111',
        merchant: 'acme',
      },
    });
    expect((result as Record<string, Record<string, unknown>>).payment.CardNumber).toBe('<redacted>');
    expect((result as Record<string, Record<string, unknown>>).payment.merchant).toBe('acme');
  });

  it('redacts array of payments — each item redacted', () => {
    const result = redact([
      { CardNumber: '4111', amount: 100 },
      { CardNumber: '5555', amount: 200 },
    ]) as Array<Record<string, unknown>>;
    expect(result[0]!.CardNumber).toBe('<redacted>');
    expect(result[1]!.CardNumber).toBe('<redacted>');
    expect(result[0]!.amount).toBe(100);
  });

  it('preserves non-PCI keys unchanged', () => {
    const result = redact({
      tenant_id: 'abc',
      event_type_id: 1796,
      viva_order_code: '123456',
    });
    expect(result).toEqual({
      tenant_id: 'abc',
      event_type_id: 1796,
      viva_order_code: '123456',
    });
  });

  it('redacts camelCase alias cardNumber', () => {
    const result = redact({ cardNumber: '4111', ok: true });
    expect((result as Record<string, unknown>).cardNumber).toBe('<redacted>');
    expect((result as Record<string, unknown>).ok).toBe(true);
  });

  it('redacts alias cvv', () => {
    const result = redact({ cvv: '123', ok: true });
    expect((result as Record<string, unknown>).cvv).toBe('<redacted>');
  });

  it('redacts alias cvc', () => {
    const result = redact({ cvc: '123' });
    expect((result as Record<string, unknown>).cvc).toBe('<redacted>');
  });

  it('redacts alias pan', () => {
    const result = redact({ pan: '4111111111111111' });
    expect((result as Record<string, unknown>).pan).toBe('<redacted>');
  });

  it('redacts PascalCase Pan', () => {
    const result = redact({ Pan: '4111111111111111' });
    expect((result as Record<string, unknown>).Pan).toBe('<redacted>');
  });

  it('redacts Cvc2', () => {
    const result = redact({ Cvc2: '999' });
    expect((result as Record<string, unknown>).Cvc2).toBe('<redacted>');
  });

  it('redacts CardHolderName', () => {
    const result = redact({ CardHolderName: 'John Doe' });
    expect((result as Record<string, unknown>).CardHolderName).toBe('<redacted>');
  });

  it('redacts Track2', () => {
    const result = redact({ Track2: ';4111=2512...' });
    expect((result as Record<string, unknown>).Track2).toBe('<redacted>');
  });

  it('already-redacted sentinel is left unchanged', () => {
    const result = redact({ CardNumber: '<redacted>' });
    expect((result as Record<string, unknown>).CardNumber).toBe('<redacted>');
  });

  it('null and undefined pass through', () => {
    expect(redact(null)).toBeNull();
    expect(redact(undefined)).toBeUndefined();
  });

  it('primitives pass through', () => {
    expect(redact('string')).toBe('string');
    expect(redact(42)).toBe(42);
    expect(redact(true)).toBe(true);
  });
});
