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
import type { RedisLockClient } from '@sakeetech/viva-payments-core/auth';
import type { VivaEnvironment } from '@sakeetech/viva-payments-core/types';
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
/** Test-only: reset the once-per-process flag. */
export declare function _resetConfigStartupNoticeForTesting(): void;
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
export declare function loadConfigFromEnv(env?: NodeJS.ProcessEnv): VivaPluginConfig;
//# sourceMappingURL=config.d.ts.map