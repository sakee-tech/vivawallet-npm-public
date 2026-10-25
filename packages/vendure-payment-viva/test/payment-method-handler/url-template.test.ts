/**
 * test/payment-method-handler/url-template.test.ts
 *
 * Tests {token} substitution helper.
 */

import { describe, it, expect } from 'vitest';
import { substitute } from '../../src/util/url-template.js';

describe('substitute', () => {
  it('single token substitution', () => {
    expect(substitute('https://example.com/success?ref={orderCode}', { orderCode: '12345' })).toBe(
      'https://example.com/success?ref=12345',
    );
  });

  it('multiple token substitution', () => {
    expect(substitute('{host}/checkout/{orderCode}?lang={lang}', { host: 'example.com', orderCode: '99', lang: 'en' })).toBe(
      'example.com/checkout/99?lang=en',
    );
  });

  it('unknown token left unchanged', () => {
    expect(substitute('https://example.com/{unknown}', { orderCode: '123' })).toBe(
      'https://example.com/{unknown}',
    );
  });

  it('no tokens → string unchanged', () => {
    const url = 'https://example.com/static';
    expect(substitute(url, {})).toBe(url);
  });

  it('empty string → empty string', () => {
    expect(substitute('', { orderCode: '1' })).toBe('');
  });

  it('token appearing twice is replaced both times', () => {
    expect(substitute('{a}/{a}', { a: 'x' })).toBe('x/x');
  });
});
