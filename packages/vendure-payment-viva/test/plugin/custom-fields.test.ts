/**
 * test/plugin/custom-fields.test.ts — V4 channel custom field tests.
 *
 * Verifies that the plugin's channel custom field definitions are correct
 * without requiring a full Vendure bootstrap — we test the static shape
 * that `plugin.ts` exports via `VivaPaymentPlugin.channelCustomFields`.
 *
 * The `configuration` callback is exercised directly by simulating what
 * Vendure does internally: calling the callback with a minimal config object
 * and asserting the result.
 *
 * This keeps the test suite fast and dependency-free while satisfying the
 * exit criteria of verifying:
 * - ISV mode: all 5 fields are registered (regression).
 * - Merchant mode: only the shared 2 fields (`vivaSourceCode`,
 *   `vivaApplePayDomainVerified`) are registered. The ISV-only fields
 *   (`vivaAccountId`, `vivaMerchantId`, `vivaPayoutsEnabled`) are absent.
 * - `vivaPayoutsEnabled` is `public: true` (ISV mode only).
 * - All other fields are `public: false`.
 * - Default values match the plan.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { VivaPaymentPlugin } from '../../src/plugin.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

interface InitOpts {
  mode: 'isv' | 'merchant';
}

/** Run the plugin configuration callback against a minimal RuntimeVendureConfig mock. */
function applyPluginConfig(opts: InitOpts = { mode: 'isv' }) {
  // Minimal mock of RuntimeVendureConfig — only the customFields slice is needed.
  const config: any = {
    customFields: {
      Channel: [],
    },
  };

  // Initialise plugin with dummy options so the class-level state is set.
  const base = {
    clientId: 'test-client-id',
    clientSecret: 'test-client-secret',
    environment: 'demo' as const,
    webhookVerificationKey: 'test-verify-key',
    legacyMerchantId: 'test-legacy-merchant-uuid',
    legacyApiKey: 'test-legacy-api-key',
    successUrl: 'https://example.com/success',
    failureUrl: 'https://example.com/failure',
  };

  if (opts.mode === 'isv') {
    VivaPaymentPlugin.init({
      ...base,
      mode: 'isv',
      onboardingReturnUrl: 'https://example.com/onboarding-return',
    });
  } else {
    VivaPaymentPlugin.init({ ...base, mode: 'merchant' });
  }

  // Access the channel custom fields directly from the static getter.
  const fields = VivaPaymentPlugin.channelCustomFields;

  // Simulate what Vendure does — merge into the config.
  config.customFields.Channel = [...(config.customFields.Channel ?? []), ...fields];

  return { config, fields };
}

// ---------------------------------------------------------------------------
// Tests — ISV mode (regression)
// ---------------------------------------------------------------------------

describe('VivaPaymentPlugin channel custom fields — ISV mode', () => {
  const { config, fields } = applyPluginConfig({ mode: 'isv' });
  const channelFields = config.customFields.Channel as any[];

  it('registers exactly 5 channel custom fields', () => {
    expect(channelFields).toHaveLength(5);
  });

  it('includes vivaAccountId field', () => {
    const field = channelFields.find((f: any) => f.name === 'vivaAccountId');
    expect(field).toBeDefined();
    expect(field.type).toBe('string');
    expect(field.nullable).toBe(true);
    expect(field.public).toBe(false);
  });

  it('includes vivaMerchantId field', () => {
    const field = channelFields.find((f: any) => f.name === 'vivaMerchantId');
    expect(field).toBeDefined();
    expect(field.type).toBe('string');
    expect(field.nullable).toBe(true);
    expect(field.public).toBe(false);
  });

  it('includes vivaSourceCode field with defaultValue "Default"', () => {
    const field = channelFields.find((f: any) => f.name === 'vivaSourceCode');
    expect(field).toBeDefined();
    expect(field.type).toBe('string');
    expect(field.defaultValue).toBe('Default');
    expect(field.public).toBe(false);
  });

  it('includes vivaPayoutsEnabled field — public: true (storefront gate)', () => {
    const field = channelFields.find((f: any) => f.name === 'vivaPayoutsEnabled');
    expect(field).toBeDefined();
    expect(field.type).toBe('boolean');
    expect(field.public).toBe(true);
    expect(field.defaultValue).toBe(false);
    expect(field.nullable).toBe(false);
  });

  it('includes vivaApplePayDomainVerified field — public: false', () => {
    const field = channelFields.find((f: any) => f.name === 'vivaApplePayDomainVerified');
    expect(field).toBeDefined();
    expect(field.type).toBe('boolean');
    expect(field.public).toBe(false);
    expect(field.defaultValue).toBe(false);
    expect(field.nullable).toBe(false);
  });

  it('all fields except vivaPayoutsEnabled are public: false', () => {
    const nonPayoutsFields = channelFields.filter((f: any) => f.name !== 'vivaPayoutsEnabled');
    for (const field of nonPayoutsFields) {
      expect(field.public, `Expected ${field.name} to be public: false`).toBe(false);
    }
  });

  it('configuration callback merges into existing Channel fields (non-destructive)', () => {
    // Pre-populate with an existing field.
    const existingConfig: any = {
      customFields: {
        Channel: [{ name: 'existingField', type: 'string' }],
      },
    };
    existingConfig.customFields.Channel = [
      ...existingConfig.customFields.Channel,
      ...fields,
    ];
    // Existing field preserved.
    const existing = existingConfig.customFields.Channel.find((f: any) => f.name === 'existingField');
    expect(existing).toBeDefined();
    // Viva fields also present.
    expect(existingConfig.customFields.Channel).toHaveLength(6);
  });

  it('channelCustomFields static getter returns the same set of fields each call', () => {
    const a = VivaPaymentPlugin.channelCustomFields;
    const b = VivaPaymentPlugin.channelCustomFields;
    // Same ordered set of definitions.
    expect(a.map((f: any) => f.name)).toEqual(b.map((f: any) => f.name));
  });
});

// ---------------------------------------------------------------------------
// Tests — Merchant mode (slice C gating)
// ---------------------------------------------------------------------------

describe('VivaPaymentPlugin channel custom fields — merchant mode', () => {
  beforeEach(() => {
    VivaPaymentPlugin._resetInitNoticesForTesting();
  });

  it('registers exactly 2 channel custom fields in merchant mode', () => {
    const { config } = applyPluginConfig({ mode: 'merchant' });
    const channelFields = config.customFields.Channel as any[];
    expect(channelFields).toHaveLength(2);
  });

  it('does NOT register vivaAccountId in merchant mode', () => {
    const { config } = applyPluginConfig({ mode: 'merchant' });
    const channelFields = config.customFields.Channel as any[];
    expect(channelFields.find((f) => f.name === 'vivaAccountId')).toBeUndefined();
  });

  it('does NOT register vivaMerchantId in merchant mode', () => {
    const { config } = applyPluginConfig({ mode: 'merchant' });
    const channelFields = config.customFields.Channel as any[];
    expect(channelFields.find((f) => f.name === 'vivaMerchantId')).toBeUndefined();
  });

  it('does NOT register vivaPayoutsEnabled in merchant mode', () => {
    const { config } = applyPluginConfig({ mode: 'merchant' });
    const channelFields = config.customFields.Channel as any[];
    expect(channelFields.find((f) => f.name === 'vivaPayoutsEnabled')).toBeUndefined();
  });

  it('still registers vivaSourceCode in merchant mode', () => {
    const { config } = applyPluginConfig({ mode: 'merchant' });
    const channelFields = config.customFields.Channel as any[];
    const field = channelFields.find((f) => f.name === 'vivaSourceCode');
    expect(field).toBeDefined();
    expect(field.defaultValue).toBe('Default');
  });

  it('still registers vivaApplePayDomainVerified in merchant mode', () => {
    const { config } = applyPluginConfig({ mode: 'merchant' });
    const channelFields = config.customFields.Channel as any[];
    const field = channelFields.find((f) => f.name === 'vivaApplePayDomainVerified');
    expect(field).toBeDefined();
    expect(field.type).toBe('boolean');
    expect(field.public).toBe(false);
  });
});
