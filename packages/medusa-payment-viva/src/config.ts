/**
 * config.ts — env parsing and runtime validation for medusa-payment-viva.
 *
 * Reads environment variables and returns a strongly-typed `VivaPluginConfig`
 * discriminated union, branching on `mode: 'merchant' | 'isv'`.
 *
 * Plan reference: docs/plans/multi-mode-v0.md §5 (config shape), §9.1 (env vars).
 *
 * Back-compat (one minor — 0.2.x):
 * - `VIVA_ISV_CLIENT_ID` / `VIVA_ISV_CLIENT_SECRET` are accepted as aliases
 *   for `VIVA_CLIENT_ID` / `VIVA_CLIENT_SECRET`, with a deprecation warning.
 *   Removal in 0.3.0.
 *
 * Auto-detect:
 * - If `VIVA_MODE` is unset and any `VIVA_RESELLER_*` is set, mode defaults
 *   to `'isv'`. Otherwise mode defaults to `'merchant'`.
 *
 * Pure function; accepts env as a parameter for testability.
 * No Zod — manual validation per plan P13.
 *
 * @see references/viva-docs/md/isv-credentials.txt:107 (credential types)
 * @see references/viva-docs/md/oauth2-authentication.txt:119 (client_id, client_secret)
 * @see references/viva-docs/md/payment-isv-api.txt:1 (reseller credentials)
 */

import { VivaValidationError } from '@sakeetech/viva-payments-core/errors';
import type { RedisLockClient } from '@sakeetech/viva-payments-core/auth';
import type { VivaEnvironment } from '@sakeetech/viva-payments-core/types';

// ---------------------------------------------------------------------------
// Public types — discriminated union on `mode`
// ---------------------------------------------------------------------------

export type VivaMode = 'merchant' | 'isv';

export type VivaRefundStrategy = 'auto' | 'fast' | 'standard';

/**
 * Fields shared by both modes.
 *
 * Field name rationale:
 * - `clientId` / `clientSecret` — mode-agnostic; the OAuth2 client_credentials
 *   pair works for both merchant and ISV modes.
 * - `legacyMerchantId` / `legacyApiKey` — Basic-auth pair against the legacy
 *   host. Required in both modes for Standard refund and IsvSources (merchant
 *   variant). Probe-verified 2026-04-25: POST /checkout/v2/transactions/{id}
 *   returns 405, only the legacy host works for refunds.
 */
export interface VivaCommonConfig {
  /**
   * Viva API environment.
   * @see references/viva-docs/md/oauth2-authentication.txt:145
   */
  environment: VivaEnvironment;

  /**
   * OAuth2 client_credentials — mode-agnostic.
   * Renamed from `isvClientId`/`isvClientSecret` in 0.2.0.
   * @see references/viva-docs/md/oauth2-authentication.txt:119
   */
  clientId: string;
  clientSecret: string;

  /**
   * Legacy Basic-auth credentials. REQUIRED in both modes for Standard refund.
   *
   * Probe-verified 2026-04-25 (F1): POST /checkout/v2/transactions/{id} returns
   * 405; only POST /api/transactions/{id} on the legacy host works.
   *
   * @see references/viva-docs/md/merchant-id-and-api-key.txt:1
   * @see references/viva-docs/md/tut-create-recurring-payment.txt:288
   */
  legacyMerchantId: string;
  legacyApiKey: string;

  /**
   * Webhook verification key (GET challenge-response).
   * @see references/viva-docs/md/isv-credentials.txt:107
   */
  webhookVerificationKey: string;

  /**
   * Refund strategy. Defaults to `'auto'`.
   *
   * 'auto'     — pick fast or standard based on transaction state.
   * 'fast'     — POST /api/transactions/refund (fast/OAuth2 path).
   * 'standard' — POST /api/transactions/{id} (legacy Basic auth).
   */
  refundStrategy?: VivaRefundStrategy;

  /**
   * Optional Redis lock client for multi-worker token-refresh coordination
   * (plan P11).
   */
  redis?: RedisLockClient;

  /**
   * Optional OpenTelemetry-compatible observability hook (plan P16).
   */
  observability?: {
    onSpan?: (name: string, fn: () => Promise<unknown>) => Promise<unknown>;
  };

  /**
   * Whether to process Sale Transactions HMAC webhook events.
   * v1 default: false (HMAC dropped per amendment A8). Reserved for v1.1.
   */
  enableSaleTransactionsWebhook?: boolean;

  /**
   * Admin token for guarding internal endpoints (/viva/internal/*).
   * Read from VIVA_ADMIN_TOKEN. Optional — when absent, internal endpoints
   * return 401 with reason='admin-token-not-configured'.
   */
  adminToken?: string;
}

/**
 * Merchant-mode config. Used when the plugin acts on behalf of a single
 * direct Viva merchant account (no reseller hierarchy).
 */
export interface VivaMerchantConfig extends VivaCommonConfig {
  mode: 'merchant';
  /**
   * Optional Smart Checkout sourceCode. Defaults to `'Default'` when unset.
   *
   * @see references/viva-docs/md/payment-source-for-isv.txt:101
   */
  sourceCode?: string;
}

/**
 * ISV-mode config. Used when the plugin acts on behalf of merchants under
 * an ISV partner agreement.
 */
export interface VivaIsvConfig extends VivaCommonConfig {
  mode: 'isv';
  /**
   * Reseller Basic-auth — required only when the plugin will call
   * POST /api/sources (IsvSources). All three fields are all-or-nothing.
   *
   * @see references/viva-docs/md/payment-isv-api.txt:1
   */
  reseller?: {
    resellerId: string;
    merchantId: string;
    resellerApiKey: string;
  };
}

export type VivaPluginConfig = VivaMerchantConfig | VivaIsvConfig;

// ---------------------------------------------------------------------------
// Module-local startup state — used to ensure the "defaulting to merchant
// mode" notice fires at most once per process.
// ---------------------------------------------------------------------------

let _defaultModeNoticeShown = false;

/** Test-only: reset the once-per-process flag. */
export function _resetConfigStartupNoticeForTesting(): void {
  _defaultModeNoticeShown = false;
}

// ---------------------------------------------------------------------------
// Loader
// ---------------------------------------------------------------------------

/**
 * Parses the plugin configuration from environment variables.
 *
 * Required (both modes):
 *   - VIVA_CLIENT_ID            (alias: VIVA_ISV_CLIENT_ID — deprecated)
 *   - VIVA_CLIENT_SECRET        (alias: VIVA_ISV_CLIENT_SECRET — deprecated)
 *   - VIVA_WEBHOOK_VERIFICATION_KEY
 *   - VIVA_MERCHANT_ID          (legacy Basic auth)
 *   - VIVA_API_KEY              (legacy Basic auth)
 *
 * Optional:
 *   - VIVA_MODE                 ('merchant' | 'isv'; default 'merchant',
 *                                auto-detected as 'isv' when VIVA_RESELLER_* set)
 *   - VIVA_ENVIRONMENT          ('demo' | 'production'; default 'demo')
 *   - VIVA_REFUND_STRATEGY      ('auto' | 'fast' | 'standard'; default 'auto')
 *   - VIVA_SOURCE_CODE          (merchant mode only; default 'Default')
 *   - VIVA_RESELLER_ID,
 *     VIVA_RESELLER_MERCHANT_ID,
 *     VIVA_RESELLER_API_KEY     (ISV mode only; all-or-nothing)
 *   - VIVA_ADMIN_TOKEN
 *
 * @throws VivaValidationError with field-level messages for missing values.
 */
export function loadConfigFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): VivaPluginConfig {
  const errors: string[] = [];

  // -------------------------------------------------------------------------
  // VIVA_MODE — discriminator, with auto-detect + default-warning.
  // -------------------------------------------------------------------------
  const rawMode = env['VIVA_MODE'];
  const resellerIdRaw = env['VIVA_RESELLER_ID'];
  const resellerMerchantIdRaw = env['VIVA_RESELLER_MERCHANT_ID'];
  const resellerApiKeyRaw = env['VIVA_RESELLER_API_KEY'];
  const anyResellerSet = Boolean(
    resellerIdRaw || resellerMerchantIdRaw || resellerApiKeyRaw,
  );

  let mode: VivaMode;
  if (rawMode === undefined || rawMode === '') {
    mode = anyResellerSet ? 'isv' : 'merchant';
    if (!_defaultModeNoticeShown) {
      _defaultModeNoticeShown = true;
      console.warn(
        `[viva] VIVA_MODE is unset — defaulting to '${mode}' mode` +
          (anyResellerSet
            ? ' (auto-detected from VIVA_RESELLER_*).'
            : '. Set VIVA_MODE=isv if running under an ISV partner.'),
      );
    }
  } else if (rawMode === 'merchant' || rawMode === 'isv') {
    mode = rawMode;
  } else {
    errors.push(
      `VIVA_MODE must be 'merchant' or 'isv', got '${rawMode}'`,
    );
    mode = 'merchant'; // placeholder; we'll throw before using it
  }

  // -------------------------------------------------------------------------
  // VIVA_ENVIRONMENT
  // -------------------------------------------------------------------------
  const rawEnv = env['VIVA_ENVIRONMENT'] ?? 'demo';
  if (rawEnv !== 'demo' && rawEnv !== 'production') {
    errors.push(
      `VIVA_ENVIRONMENT must be 'demo' or 'production', got '${rawEnv}'`,
    );
  }
  const environment = rawEnv as VivaEnvironment;

  // -------------------------------------------------------------------------
  // OAuth2 client_credentials (with one-minor back-compat aliases).
  // -------------------------------------------------------------------------
  let clientId = env['VIVA_CLIENT_ID'];
  if (!clientId && env['VIVA_ISV_CLIENT_ID']) {
    clientId = env['VIVA_ISV_CLIENT_ID'];
    console.warn(
      '[viva] VIVA_ISV_CLIENT_ID is deprecated, rename to VIVA_CLIENT_ID. ' +
        'Removal in 0.3.0.',
    );
  }
  if (!clientId) {
    errors.push('VIVA_CLIENT_ID is required');
  }

  let clientSecret = env['VIVA_CLIENT_SECRET'];
  if (!clientSecret && env['VIVA_ISV_CLIENT_SECRET']) {
    clientSecret = env['VIVA_ISV_CLIENT_SECRET'];
    console.warn(
      '[viva] VIVA_ISV_CLIENT_SECRET is deprecated, rename to VIVA_CLIENT_SECRET. ' +
        'Removal in 0.3.0.',
    );
  }
  if (!clientSecret) {
    errors.push('VIVA_CLIENT_SECRET is required');
  }

  const webhookVerificationKey = env['VIVA_WEBHOOK_VERIFICATION_KEY'];
  if (!webhookVerificationKey) {
    errors.push('VIVA_WEBHOOK_VERIFICATION_KEY is required');
  }

  // -------------------------------------------------------------------------
  // Legacy Basic-auth credentials — required in both modes for Standard refund.
  // -------------------------------------------------------------------------
  const legacyMerchantId = env['VIVA_MERCHANT_ID'];
  if (!legacyMerchantId) {
    errors.push(
      'VIVA_MERCHANT_ID is required — needed for refundPayment (Viva legacy Basic-auth API). ' +
        'Probe-verified 2026-04-25: POST /checkout/v2/transactions/{id} returns 405; ' +
        'only POST /api/transactions/{id} on the legacy host works.',
    );
  }

  const legacyApiKey = env['VIVA_API_KEY'];
  if (!legacyApiKey) {
    errors.push(
      'VIVA_API_KEY is required — needed for refundPayment (Viva legacy Basic-auth API). ' +
        'Pair with VIVA_MERCHANT_ID to authenticate refund calls.',
    );
  }

  // -------------------------------------------------------------------------
  // VIVA_REFUND_STRATEGY (default 'auto').
  // -------------------------------------------------------------------------
  const rawRefundStrategy = env['VIVA_REFUND_STRATEGY'];
  let refundStrategy: VivaRefundStrategy = 'auto';
  if (rawRefundStrategy !== undefined && rawRefundStrategy !== '') {
    if (
      rawRefundStrategy === 'auto' ||
      rawRefundStrategy === 'fast' ||
      rawRefundStrategy === 'standard'
    ) {
      refundStrategy = rawRefundStrategy;
    } else {
      errors.push(
        `VIVA_REFUND_STRATEGY must be 'auto', 'fast', or 'standard', got '${rawRefundStrategy}'`,
      );
    }
  }

  // -------------------------------------------------------------------------
  // Reseller credentials (ISV-only, all-or-nothing).
  // -------------------------------------------------------------------------
  const resellerSetCount = [
    resellerIdRaw,
    resellerMerchantIdRaw,
    resellerApiKeyRaw,
  ].filter(Boolean).length;

  if (mode === 'merchant' && resellerSetCount > 0) {
    // Don't throw — warn and ignore. Reseller fields are unused in merchant mode.
    console.warn(
      '[viva] VIVA_RESELLER_* env vars are set but VIVA_MODE=merchant. ' +
        'These values are ignored in merchant mode.',
    );
  }

  if (mode === 'isv' && resellerSetCount > 0 && resellerSetCount < 3) {
    const missing: string[] = [];
    if (!resellerIdRaw) missing.push('VIVA_RESELLER_ID');
    if (!resellerMerchantIdRaw) missing.push('VIVA_RESELLER_MERCHANT_ID');
    if (!resellerApiKeyRaw) missing.push('VIVA_RESELLER_API_KEY');
    errors.push(
      `Reseller credentials are partially set. Missing: ${missing.join(', ')}. ` +
        `Either set all three (VIVA_RESELLER_ID, VIVA_RESELLER_MERCHANT_ID, VIVA_RESELLER_API_KEY) or none.`,
    );
  }

  // -------------------------------------------------------------------------
  // Throw aggregated validation errors before constructing the config object.
  // -------------------------------------------------------------------------
  if (errors.length > 0) {
    throw new VivaValidationError({
      message: `Invalid Viva plugin configuration:\n  ${errors.join('\n  ')}`,
    });
  }

  // -------------------------------------------------------------------------
  // VIVA_ADMIN_TOKEN — warn in production if missing.
  // -------------------------------------------------------------------------
  const adminToken = env['VIVA_ADMIN_TOKEN'];
  if (!adminToken && environment === 'production') {
    console.warn(
      '[viva] VIVA_ADMIN_TOKEN is not set. Internal endpoints (/viva/internal/*) will return 401.',
    );
  }

  // -------------------------------------------------------------------------
  // Compose common fields.
  // -------------------------------------------------------------------------
  const common: VivaCommonConfig = {
    environment,
    clientId: clientId!,
    clientSecret: clientSecret!,
    legacyMerchantId: legacyMerchantId!,
    legacyApiKey: legacyApiKey!,
    webhookVerificationKey: webhookVerificationKey!,
    refundStrategy,
    ...(adminToken !== undefined ? { adminToken } : {}),
  };

  // -------------------------------------------------------------------------
  // Branch on mode.
  // -------------------------------------------------------------------------
  if (mode === 'merchant') {
    const sourceCode = env['VIVA_SOURCE_CODE'];
    const merchantConfig: VivaMerchantConfig = {
      ...common,
      mode: 'merchant',
      ...(sourceCode !== undefined && sourceCode !== ''
        ? { sourceCode }
        : {}),
    };
    return merchantConfig;
  }

  // mode === 'isv'
  const reseller =
    resellerSetCount === 3
      ? {
          resellerId: resellerIdRaw!,
          merchantId: resellerMerchantIdRaw!,
          resellerApiKey: resellerApiKeyRaw!,
        }
      : undefined;

  const isvConfig: VivaIsvConfig = {
    ...common,
    mode: 'isv',
    ...(reseller !== undefined ? { reseller } : {}),
  };
  return isvConfig;
}
