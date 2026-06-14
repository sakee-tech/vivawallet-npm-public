/**
 * test/config/mode-validation.test.ts — discriminated-union config validation.
 *
 * Covers the slice-A multi-mode refactor:
 *  - `mode: 'merchant'` produces a VivaMerchantOptions.
 *  - `mode: 'isv'` produces a VivaIsvOptions.
 *  - missing mode defaults to 'merchant' with a one-time startup warning.
 *  - missing mode + ISV-only fields auto-detects 'isv' (no warning).
 *  - merchant + ISV resolvers → runtime warning, not a throw.
 *  - deprecated isvClientId / isvClientSecret accepted with deprecation warning.
 *  - merchant-mode createPayment no longer throws VIVA_MODE_MISMATCH
 *    (slice-B implements merchant-mode handlers — covered in
 *    test/merchant-mode/* for behavioural coverage).
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { normalizePluginOptions, _resetInitNoticesForTesting } from '../../src/util/normalize-options.js';
import { VivaValidationError } from '@sakeetech/viva-payments-core/errors';
import type { VivaPaymentPluginInitInput } from '../../src/types.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function baseInput(extra: Partial<VivaPaymentPluginInitInput> = {}): VivaPaymentPluginInitInput {
  return {
    clientId: 'test-client',
    clientSecret: 'test-secret',
    environment: 'demo',
    webhookVerificationKey: 'verify-key',
    legacyMerchantId: 'legacy-merchant',
    legacyApiKey: 'legacy-key',
    successUrl: 'https://example.com/success',
    failureUrl: 'https://example.com/failure',
    ...extra,
  };
}

beforeEach(() => {
  _resetInitNoticesForTesting();
});

// ---------------------------------------------------------------------------
// 1. Explicit merchant mode
// ---------------------------------------------------------------------------

describe('normalizePluginOptions — mode', () => {
  it('mode: "merchant" produces a VivaMerchantOptions', () => {
    const out = normalizePluginOptions(baseInput({ mode: 'merchant', sourceCode: 'CustomSource' }));
    expect(out.mode).toBe('merchant');
    if (out.mode === 'merchant') {
      expect(out.clientId).toBe('test-client');
      expect(out.sourceCode).toBe('CustomSource');
    }
  });

  // -------------------------------------------------------------------------
  // 2. Explicit ISV mode
  // -------------------------------------------------------------------------

  it('mode: "isv" produces a VivaIsvOptions', () => {
    const resolveMerchantId = () => 'merchant-uuid-xyz';
    const out = normalizePluginOptions(
      baseInput({
        mode: 'isv',
        resolveMerchantId,
        onboardingReturnUrl: 'https://example.com/onboarding-return',
      }),
    );
    expect(out.mode).toBe('isv');
    if (out.mode === 'isv') {
      expect(out.resolveMerchantId).toBe(resolveMerchantId);
      expect(out.onboardingReturnUrl).toBe('https://example.com/onboarding-return');
    }
  });

  // -------------------------------------------------------------------------
  // 3. Default mode = merchant + startup warning
  // -------------------------------------------------------------------------

  it('no mode + no ISV fields defaults to "merchant" with one-time warning', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const out = normalizePluginOptions(baseInput());
    expect(out.mode).toBe('merchant');
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining(`mode is unset — defaulting to 'merchant'`),
    );

    // Calling again must NOT emit a second warning.
    warnSpy.mockClear();
    normalizePluginOptions(baseInput());
    expect(warnSpy).not.toHaveBeenCalled();

    warnSpy.mockRestore();
  });

  // -------------------------------------------------------------------------
  // 4. Auto-detect ISV
  // -------------------------------------------------------------------------

  it('no mode + resolveMerchantId auto-detects "isv" (no warning)', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const out = normalizePluginOptions(
      baseInput({
        resolveMerchantId: () => 'merchant-uuid',
        onboardingReturnUrl: 'https://example.com/return',
      }),
    );
    expect(out.mode).toBe('isv');
    // No defaulting-warning for auto-detect.
    const defaultWarnCalls = warnSpy.mock.calls.filter((c) =>
      String(c[0]).includes('mode is unset'),
    );
    expect(defaultWarnCalls).toHaveLength(0);
    warnSpy.mockRestore();
  });

  // -------------------------------------------------------------------------
  // 5. Merchant mode + ISV resolvers → runtime warning
  // -------------------------------------------------------------------------

  it('mode: "merchant" + resolveMerchantId emits an "ignored" warning', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const out = normalizePluginOptions(
      baseInput({
        mode: 'merchant',
        resolveMerchantId: () => 'merchant-uuid',
      }),
    );
    expect(out.mode).toBe('merchant');
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining("ISV-only field(s) supplied"),
    );
    warnSpy.mockRestore();
  });

  // -------------------------------------------------------------------------
  // 6. Deprecated isvClientId alias
  // -------------------------------------------------------------------------

  it('deprecated isvClientId populates clientId with deprecation warning', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const input: VivaPaymentPluginInitInput = {
      mode: 'isv',
      isvClientId: 'legacy-id',
      clientSecret: 'test-secret',
      environment: 'demo',
      webhookVerificationKey: 'verify-key',
      legacyMerchantId: 'legacy-merchant',
      legacyApiKey: 'legacy-key',
      successUrl: 'https://example.com/success',
      failureUrl: 'https://example.com/failure',
      onboardingReturnUrl: 'https://example.com/return',
    };
    const out = normalizePluginOptions(input);
    expect(out.clientId).toBe('legacy-id');
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('`isvClientId` is deprecated'),
    );
    warnSpy.mockRestore();
  });

  // -------------------------------------------------------------------------
  // 7. Deprecated isvClientSecret alias
  // -------------------------------------------------------------------------

  it('deprecated isvClientSecret populates clientSecret with deprecation warning', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const input: VivaPaymentPluginInitInput = {
      mode: 'isv',
      clientId: 'test-id',
      isvClientSecret: 'legacy-secret',
      environment: 'demo',
      webhookVerificationKey: 'verify-key',
      legacyMerchantId: 'legacy-merchant',
      legacyApiKey: 'legacy-key',
      successUrl: 'https://example.com/success',
      failureUrl: 'https://example.com/failure',
      onboardingReturnUrl: 'https://example.com/return',
    };
    const out = normalizePluginOptions(input);
    expect(out.clientSecret).toBe('legacy-secret');
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('`isvClientSecret` is deprecated'),
    );
    warnSpy.mockRestore();
  });

  // -------------------------------------------------------------------------
  // Throw cases — sanity
  // -------------------------------------------------------------------------

  it('missing clientId + clientSecret throws aggregated VivaValidationError', () => {
    expect(() =>
      normalizePluginOptions({
        environment: 'demo',
        webhookVerificationKey: 'k',
        legacyMerchantId: 'lm',
        legacyApiKey: 'lk',
        successUrl: 'https://s',
        failureUrl: 'https://f',
      } as VivaPaymentPluginInitInput),
    ).toThrow(VivaValidationError);
  });

  it('mode: "isv" without onboardingReturnUrl throws', () => {
    expect(() =>
      normalizePluginOptions(
        baseInput({
          mode: 'isv',
        }),
      ),
    ).toThrow(/onboardingReturnUrl is required/);
  });
});

// ---------------------------------------------------------------------------
// 8. Merchant-mode handlers (slice B) — behavioural tests live in
//    test/merchant-mode/*. This file only validates config normalization.
// ---------------------------------------------------------------------------
