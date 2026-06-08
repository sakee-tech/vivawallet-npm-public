/**
 * config.test.ts — unit tests for loadConfigFromEnv.
 *
 * No DB, no network. Pure function tests.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  loadConfigFromEnv,
  _resetConfigStartupNoticeForTesting,
} from '../src/config.js';
import { VivaValidationError } from '@sakeetech/viva-payments-core/errors';

describe('loadConfigFromEnv', () => {
  const VALID_BASE = {
    VIVA_CLIENT_ID: 'test-client-id',
    VIVA_CLIENT_SECRET: 'test-client-secret',
    VIVA_WEBHOOK_VERIFICATION_KEY: 'test-webhook-key',
    // Required for refundPayment (probe-verified 2026-04-25 F1):
    // Viva returns 405 on POST /checkout/v2/transactions/{id} — legacy Basic auth required.
    VIVA_MERCHANT_ID: 'test-merchant-uuid',
    VIVA_API_KEY: 'test-api-key',
  };

  let warnSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    _resetConfigStartupNoticeForTesting();
    warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    warnSpy.mockRestore();
  });

  // ---------------------------------------------------------------------------
  // Happy path + base shape
  // ---------------------------------------------------------------------------

  it('loads valid env into typed config', () => {
    const config = loadConfigFromEnv(VALID_BASE);
    expect(config.environment).toBe('demo');
    expect(config.mode).toBe('merchant');
    expect(config.clientId).toBe('test-client-id');
    expect(config.clientSecret).toBe('test-client-secret');
    expect(config.webhookVerificationKey).toBe('test-webhook-key');
    expect(config.legacyMerchantId).toBe('test-merchant-uuid');
    expect(config.legacyApiKey).toBe('test-api-key');
    expect(config.refundStrategy).toBe('auto');
  });

  it('respects VIVA_ENVIRONMENT=production', () => {
    const config = loadConfigFromEnv({
      ...VALID_BASE,
      VIVA_ENVIRONMENT: 'production',
    });
    expect(config.environment).toBe('production');
  });

  // ---------------------------------------------------------------------------
  // Required-field errors
  // ---------------------------------------------------------------------------

  it('throws VivaValidationError on missing VIVA_CLIENT_ID', () => {
    const env = {
      VIVA_CLIENT_SECRET: 'secret',
      VIVA_WEBHOOK_VERIFICATION_KEY: 'key',
      VIVA_MERCHANT_ID: 'mid',
      VIVA_API_KEY: 'apikey',
    };
    expect(() => loadConfigFromEnv(env)).toThrow(VivaValidationError);
    expect(() => loadConfigFromEnv(env)).toThrow(/VIVA_CLIENT_ID is required/);
  });

  it('throws VivaValidationError on missing VIVA_CLIENT_SECRET', () => {
    const env = {
      VIVA_CLIENT_ID: 'id',
      VIVA_WEBHOOK_VERIFICATION_KEY: 'key',
      VIVA_MERCHANT_ID: 'mid',
      VIVA_API_KEY: 'apikey',
    };
    expect(() => loadConfigFromEnv(env)).toThrow(VivaValidationError);
    expect(() => loadConfigFromEnv(env)).toThrow(/VIVA_CLIENT_SECRET is required/);
  });

  it('throws VivaValidationError on missing VIVA_WEBHOOK_VERIFICATION_KEY', () => {
    const env = {
      VIVA_CLIENT_ID: 'id',
      VIVA_CLIENT_SECRET: 'secret',
      VIVA_MERCHANT_ID: 'mid',
      VIVA_API_KEY: 'apikey',
    };
    expect(() => loadConfigFromEnv(env)).toThrow(VivaValidationError);
    expect(() => loadConfigFromEnv(env)).toThrow(/VIVA_WEBHOOK_VERIFICATION_KEY is required/);
  });

  it('throws VivaValidationError on missing VIVA_MERCHANT_ID', () => {
    const env = {
      VIVA_CLIENT_ID: 'id',
      VIVA_CLIENT_SECRET: 'secret',
      VIVA_WEBHOOK_VERIFICATION_KEY: 'key',
      VIVA_API_KEY: 'apikey',
    };
    expect(() => loadConfigFromEnv(env)).toThrow(VivaValidationError);
    expect(() => loadConfigFromEnv(env)).toThrow(/VIVA_MERCHANT_ID is required/);
  });

  it('throws VivaValidationError on missing VIVA_API_KEY', () => {
    const env = {
      VIVA_CLIENT_ID: 'id',
      VIVA_CLIENT_SECRET: 'secret',
      VIVA_WEBHOOK_VERIFICATION_KEY: 'key',
      VIVA_MERCHANT_ID: 'mid',
    };
    expect(() => loadConfigFromEnv(env)).toThrow(VivaValidationError);
    expect(() => loadConfigFromEnv(env)).toThrow(/VIVA_API_KEY is required/);
  });

  it('throws VivaValidationError on invalid VIVA_ENVIRONMENT value', () => {
    const env = { ...VALID_BASE, VIVA_ENVIRONMENT: 'staging' };
    expect(() => loadConfigFromEnv(env)).toThrow(VivaValidationError);
    expect(() => loadConfigFromEnv(env)).toThrow(/must be 'demo' or 'production'/);
  });

  it('defaults environment to demo when VIVA_ENVIRONMENT is absent', () => {
    const config = loadConfigFromEnv(VALID_BASE);
    expect(config.environment).toBe('demo');
  });

  // ---------------------------------------------------------------------------
  // Mode discriminator
  // ---------------------------------------------------------------------------

  it('defaults mode to merchant when VIVA_MODE is unset', () => {
    const config = loadConfigFromEnv(VALID_BASE);
    expect(config.mode).toBe('merchant');
    // Startup notice should fire on the first unset-mode load.
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('VIVA_MODE is unset'),
    );
  });

  it('respects VIVA_MODE=isv', () => {
    const config = loadConfigFromEnv({ ...VALID_BASE, VIVA_MODE: 'isv' });
    expect(config.mode).toBe('isv');
  });

  it('throws VivaValidationError on invalid VIVA_MODE', () => {
    const env = { ...VALID_BASE, VIVA_MODE: 'partner' };
    expect(() => loadConfigFromEnv(env)).toThrow(VivaValidationError);
    expect(() => loadConfigFromEnv(env)).toThrow(/VIVA_MODE must be 'merchant' or 'isv'/);
  });

  it('auto-detects ISV mode when VIVA_RESELLER_ID is set without VIVA_MODE', () => {
    const config = loadConfigFromEnv({
      ...VALID_BASE,
      VIVA_RESELLER_ID: 'reseller-1',
      VIVA_RESELLER_MERCHANT_ID: 'merchant-1',
      VIVA_RESELLER_API_KEY: 'api-key-1',
    });
    expect(config.mode).toBe('isv');
  });

  // ---------------------------------------------------------------------------
  // Back-compat aliases
  // ---------------------------------------------------------------------------

  it('accepts deprecated VIVA_ISV_CLIENT_ID alias with deprecation warning', () => {
    const env = {
      VIVA_ISV_CLIENT_ID: 'legacy-client-id',
      VIVA_CLIENT_SECRET: 'secret',
      VIVA_WEBHOOK_VERIFICATION_KEY: 'key',
      VIVA_MERCHANT_ID: 'mid',
      VIVA_API_KEY: 'apikey',
    };
    const config = loadConfigFromEnv(env);
    expect(config.clientId).toBe('legacy-client-id');
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('VIVA_ISV_CLIENT_ID is deprecated'),
    );
  });

  it('accepts deprecated VIVA_ISV_CLIENT_SECRET alias with deprecation warning', () => {
    const env = {
      VIVA_CLIENT_ID: 'id',
      VIVA_ISV_CLIENT_SECRET: 'legacy-secret',
      VIVA_WEBHOOK_VERIFICATION_KEY: 'key',
      VIVA_MERCHANT_ID: 'mid',
      VIVA_API_KEY: 'apikey',
    };
    const config = loadConfigFromEnv(env);
    expect(config.clientSecret).toBe('legacy-secret');
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('VIVA_ISV_CLIENT_SECRET is deprecated'),
    );
  });

  // ---------------------------------------------------------------------------
  // Reseller (ISV mode)
  // ---------------------------------------------------------------------------

  it('throws VivaValidationError when only one reseller var is set in ISV mode', () => {
    const env = {
      ...VALID_BASE,
      VIVA_MODE: 'isv',
      VIVA_RESELLER_ID: 'reseller-1',
    };
    expect(() => loadConfigFromEnv(env)).toThrow(VivaValidationError);
    expect(() => loadConfigFromEnv(env)).toThrow(/Reseller credentials are partially set/);
  });

  it('throws VivaValidationError when two of three reseller vars are set in ISV mode', () => {
    const env = {
      ...VALID_BASE,
      VIVA_MODE: 'isv',
      VIVA_RESELLER_ID: 'r1',
      VIVA_RESELLER_MERCHANT_ID: 'm1',
    };
    expect(() => loadConfigFromEnv(env)).toThrow(VivaValidationError);
    expect(() => loadConfigFromEnv(env)).toThrow(/VIVA_RESELLER_API_KEY/);
  });

  it('accepts all three reseller vars and populates reseller config in ISV mode', () => {
    const config = loadConfigFromEnv({
      ...VALID_BASE,
      VIVA_MODE: 'isv',
      VIVA_RESELLER_ID: 'reseller-1',
      VIVA_RESELLER_MERCHANT_ID: 'merchant-1',
      VIVA_RESELLER_API_KEY: 'api-key-1',
    });
    expect(config.mode).toBe('isv');
    if (config.mode !== 'isv') throw new Error('expected isv'); // type narrow
    expect(config.reseller).toBeDefined();
    expect(config.reseller?.resellerId).toBe('reseller-1');
    expect(config.reseller?.merchantId).toBe('merchant-1');
    expect(config.reseller?.resellerApiKey).toBe('api-key-1');
  });

  it('warns (but does not throw) when reseller vars are set in merchant mode', () => {
    const config = loadConfigFromEnv({
      ...VALID_BASE,
      VIVA_MODE: 'merchant',
      VIVA_RESELLER_ID: 'r1',
      VIVA_RESELLER_MERCHANT_ID: 'm1',
      VIVA_RESELLER_API_KEY: 'k1',
    });
    expect(config.mode).toBe('merchant');
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('ignored in merchant mode'),
    );
  });

  // ---------------------------------------------------------------------------
  // Refund strategy
  // ---------------------------------------------------------------------------

  it.each(['auto', 'fast', 'standard'] as const)(
    'accepts VIVA_REFUND_STRATEGY=%s',
    (value) => {
      const config = loadConfigFromEnv({
        ...VALID_BASE,
        VIVA_REFUND_STRATEGY: value,
      });
      expect(config.refundStrategy).toBe(value);
    },
  );

  it('throws VivaValidationError on invalid VIVA_REFUND_STRATEGY', () => {
    const env = { ...VALID_BASE, VIVA_REFUND_STRATEGY: 'lightning' };
    expect(() => loadConfigFromEnv(env)).toThrow(VivaValidationError);
    expect(() => loadConfigFromEnv(env)).toThrow(/VIVA_REFUND_STRATEGY must be/);
  });

  // ---------------------------------------------------------------------------
  // sourceCode (merchant mode)
  // ---------------------------------------------------------------------------

  it('populates sourceCode from VIVA_SOURCE_CODE in merchant mode', () => {
    const config = loadConfigFromEnv({
      ...VALID_BASE,
      VIVA_MODE: 'merchant',
      VIVA_SOURCE_CODE: 'CustomSource',
    });
    expect(config.mode).toBe('merchant');
    if (config.mode !== 'merchant') throw new Error('expected merchant');
    expect(config.sourceCode).toBe('CustomSource');
  });
});
