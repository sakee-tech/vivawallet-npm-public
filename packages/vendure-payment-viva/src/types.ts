/**
 * types.ts — Public configuration types for VivaPaymentPlugin.
 *
 * v0.2.0: `VivaPaymentPluginOptions` is now a **discriminated union** on `mode`.
 *
 * - `mode: 'isv'` (default until 0.3.0) — multi-merchant ISV partner setup.
 * - `mode: 'merchant'` — single direct Viva merchant, no reseller hierarchy.
 *
 * Field rename (one-minor back-compat):
 *   - `isvClientId`  → `clientId`     (old name accepted with deprecation warning)
 *   - `isvClientSecret` → `clientSecret`
 *
 * Plan ref: docs/plans/multi-mode-v0.md §5 (config shape), §10 (Vendure adapter).
 *
 * Vendure types (RequestContext, Order) are imported as peer-dep types only —
 * no runtime Vendure import here so the types module is safe to import in
 * non-Vendure test environments.
 *
 * viva-payments-core types are imported from sub-paths to avoid pulling in
 * implementation code.
 */

import type { MetricsHook, OTelTracerHook, Logger } from '@sakeetech/viva-payments-core/observability';
import type { VivaEnvironment } from '@sakeetech/viva-payments-core/types';

// ---------------------------------------------------------------------------
// Vendure ambient type references (provided via peer dep at runtime)
// ---------------------------------------------------------------------------

/**
 * Minimal shape of Vendure's RequestContext used in plugin callbacks.
 * Avoids importing @vendure/core in this file so unit tests don't require
 * the full Vendure dependency graph.
 */
export interface VendureRequestContext {
  readonly channelId: string | number;
  readonly channel: {
    readonly id: string | number;
    readonly code: string;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    readonly customFields: Record<string, any>;
  };
  readonly apiType: string;
}

/**
 * Minimal shape of Vendure's Order used in plugin callbacks.
 */
export interface VendureOrder {
  readonly id: string | number;
  readonly code: string;
  readonly totalWithTax: number;
  readonly currencyCode: string;
  readonly state: string;
  /**
   * Customer relation — loaded by Vendure on the order passed into
   * `createPayment` (OrderService.getOrderOrThrow includes `'customer'` in its
   * default relations). Present once `setCustomerForOrder` has run; `null` for
   * a guest order with no customer set yet.
   */
  readonly customer?: {
    readonly emailAddress?: string;
    readonly firstName?: string;
    readonly lastName?: string;
    readonly phoneNumber?: string;
  } | null;
}

// ---------------------------------------------------------------------------
// Redlock shim — injected for multi-worker semaphore upgrade (optional)
// ---------------------------------------------------------------------------

export interface RedlockClient {
  acquire(resources: string[], duration: number): Promise<{ release(): Promise<void> }>;
}

// ---------------------------------------------------------------------------
// Mode discriminator
// ---------------------------------------------------------------------------

export type VivaMode = 'merchant' | 'isv';

// ---------------------------------------------------------------------------
// Common options — fields shared by both modes
// ---------------------------------------------------------------------------

/**
 * Fields shared by both merchant and ISV mode configurations.
 *
 * Field-name rationale:
 *  - `clientId` / `clientSecret` — mode-agnostic OAuth2 client_credentials.
 *    Renamed from `isvClientId` / `isvClientSecret` in 0.2.0. Old names still
 *    accepted via `init()` with a deprecation warning (removal in 0.3.0).
 *  - `legacyMerchantId` / `legacyApiKey` — Basic-auth pair against the legacy
 *    host. Required in both modes for Standard refund + IsvSources merchant
 *    variant. Probe-verified 2026-04-25 (F1): POST /checkout/v2/transactions/{id}
 *    returns 405, only the legacy host works for refunds.
 */
export interface VivaCommonOptions {
  /** Target environment. Switches Viva API base URL. */
  environment: VivaEnvironment;

  /**
   * OAuth2 client_credentials — mode-agnostic.
   * (The credential pair differs by Self Care location, but the field shape
   * is the same in both modes.)
   *
   * @see references/viva-docs/md/oauth2-authentication.txt:119
   */
  clientId: string;

  /** OAuth2 client_credentials — paired with `clientId`. */
  clientSecret: string;

  // -------------------------------------------------------------------------
  // Legacy Basic-auth credentials (required for refundPayment).
  //
  // Probe-verified 2026-04-25 (F1): Viva returns 405 Method Not Allowed on
  // `POST /checkout/v2/transactions/{id}` (v2/OAuth2 path).
  // The ONLY working refund path is `POST /api/transactions/{transactionId}`
  // on the legacy host (demo.vivapayments.com / www.vivapayments.com) with
  // Basic auth (MerchantId:ApiKey).
  //
  // These are your Viva Merchant ID and API Key (NOT the OAuth2 client
  // credentials). Find them in Viva Self Care → Settings → API Access.
  // -------------------------------------------------------------------------

  /**
   * Viva Merchant ID (UUID) for the legacy Basic-auth API.
   * Required for `createRefund` to work.
   *
   * @see references/viva-docs/md/merchant-id-and-api-key.txt:1
   * @see references/viva-docs/md/tut-create-recurring-payment.txt:288
   */
  legacyMerchantId: string;

  /**
   * Viva API Key for the legacy Basic-auth API.
   * Required for `createRefund` to work. Paired with `legacyMerchantId`.
   *
   * @see references/viva-docs/md/merchant-id-and-api-key.txt:1
   */
  legacyApiKey: string;

  // -------------------------------------------------------------------------
  // Webhook verification
  // -------------------------------------------------------------------------

  /**
   * URL-verification key returned on Viva's GET probe at registration.
   * NOT a per-request HMAC. Generated by `vendure-viva-register-webhooks` CLI.
   */
  webhookVerificationKey: string;

  // -------------------------------------------------------------------------
  // Redirect URLs (bookkeeping only — NOT a Viva redirect mechanism)
  // -------------------------------------------------------------------------

  /**
   * Storefront success URL. `{orderCode}` is substituted server-side after Viva
   * returns the order code, and the resolved value is stored on the
   * `viva_transaction` row metadata for your own bookkeeping/observability.
   *
   * ⚠️ This is NOT sent to Viva and does NOT control the customer's
   * post-payment redirect. Viva's Smart Checkout redirects to the Success/Failure
   * URLs configured on the payment **source** (`pathSuccess` / `pathFail`), set
   * once per source via the plugin's source-onboarding endpoint
   * (`POST /api/sources`, see {@link admin-sources.controller}) or in the Viva
   * dashboard (Self Care → Sales → Online Payments → Websites). There is no
   * per-order success-redirect field in Viva's createOrder API. See
   * sakee-tech/vivawallet-npm-public#15.
   */
  successUrl: string | ((ctx: VendureRequestContext) => string);

  /**
   * Storefront failure URL. Same substitution + bookkeeping semantics as
   * {@link successUrl}, and the same caveat: NOT transmitted to Viva and does NOT
   * govern the redirect. The real failure redirect is the source's `pathFail`
   * (createOrder exposes only `urlFail` + `stateId=1`, an expiry-only redirect we
   * do not use). Configure it on the source. See
   * sakee-tech/vivawallet-npm-public#15.
   */
  failureUrl: string | ((ctx: VendureRequestContext) => string);

  // -------------------------------------------------------------------------
  // Order / customer description
  // -------------------------------------------------------------------------

  /**
   * Resolve the customer-facing transaction description (`customerTrns`) sent
   * to Viva. It appears on the Smart Checkout page and the customer's bank
   * statement, so a shop/order reference here improves UX and reconciliation.
   *
   * Default: `Order <order.code>`. The plugin always also sends
   * `merchantTrns = order.code` (merchant-facing, echoed in webhooks) — that is
   * not configurable. Both values are length-clamped on the wire (`merchantTrns`
   * ≤50, `customerTrns` ≤255).
   *
   * @example
   * resolveCustomerTrns: (order) => `Acme Store — order ${order.code}`
   */
  resolveCustomerTrns?: (order: VendureOrder, ctx: VendureRequestContext) => string;

  // -------------------------------------------------------------------------
  // Refund strategy
  // -------------------------------------------------------------------------

  /**
   * Refund strategy. Defaults to `'auto'`.
   *
   * 'auto'     — pick fast or standard based on transaction state.
   * 'fast'     — POST /api/transactions/refund (fast/OAuth2 path).
   * 'standard' — POST /api/transactions/{id} (legacy Basic auth).
   */
  refundStrategy?: 'auto' | 'fast' | 'standard';

  // -------------------------------------------------------------------------
  // Optional infrastructure injection
  // -------------------------------------------------------------------------

  /**
   * Redlock client for multi-worker distributed semaphore.
   * Default: in-process semaphore only (5 permits per merchantId).
   */
  redlock?: RedlockClient;

  /**
   * Structured logger. Default: Vendure's built-in logger (Logger from
   * @sakeetech/viva-payments-core/observability).
   */
  logger?: Logger;

  /**
   * Metrics hook for Prometheus-style counters + histograms.
   * Default: NoopMetricsHook.
   */
  metricsHook?: MetricsHook;

  /**
   * OpenTelemetry tracer hook.
   * Default: NoopTracerHook (no-op).
   */
  tracer?: OTelTracerHook;

  /**
   * IP allowlist for webhook receiver.
   * Default: Viva's published demo + production CIDRs.
   */
  webhookIpAllowlist?: string[];

  /**
   * How many trailing `X-Forwarded-For` hops are set by infrastructure you
   * actually control. The webhook source-IP check walks the X-F-F chain from
   * the **rightmost** end and picks the entry `trustedProxyDepth` from the
   * end. Defaults to `0` — ignore X-F-F entirely and use the socket address,
   * which is safe for direct exposure but rejects every webhook when a real
   * proxy sits in front.
   *
   * Typical values:
   *   0 — no proxy / direct exposure (default)
   *   1 — one reverse proxy (nginx, Caddy, ALB)
   *   2 — CDN in front of LB (e.g. Cloudflare → ALB)
   *
   * CSO Finding #2 (HIGH): leaving this at the implicit "trust leftmost X-F-F"
   * default lets any client claim to be a whitelisted Viva IP.
   *
   * @see docs/TODO-CSO.md "Finding 2"
   */
  trustedProxyDepth?: number;
}

// ---------------------------------------------------------------------------
// Merchant-mode options
// ---------------------------------------------------------------------------

/**
 * Merchant-mode config. Used when the plugin acts on behalf of a single
 * direct Viva merchant account (no reseller hierarchy).
 *
 * NOTE (slice A, v0.2.0): runtime entry points (createPayment, settlePayment,
 * cancelPayment, createRefund) currently throw `VIVA_MODE_MISMATCH` —
 * merchant-mode handlers ship in Phase 3 slice B.
 */
export interface VivaMerchantOptions extends VivaCommonOptions {
  mode: 'merchant';

  /**
   * Optional Smart Checkout sourceCode. Defaults to `'Default'` when unset.
   *
   * @see references/viva-docs/md/payment-source-for-isv.txt:101
   */
  sourceCode?: string;

  /**
   * Optional hex color (no leading `#`) for Smart Checkout theming.
   * Appended as `&color=<value>` to the Smart Checkout redirect URL.
   */
  checkoutColor?: string;
}

// ---------------------------------------------------------------------------
// ISV-mode options
// ---------------------------------------------------------------------------

/**
 * ISV-mode config. Used when the plugin acts on behalf of merchants under
 * an ISV partner agreement. All per-tenant resolvers + onboarding fields
 * live here.
 */
export interface VivaIsvOptions extends VivaCommonOptions {
  mode: 'isv';

  // -------------------------------------------------------------------------
  // Per-Channel resolution callbacks (all optional — defaults read from
  // Channel custom fields).
  // -------------------------------------------------------------------------

  /**
   * Resolve the Viva merchantId UUID for the current channel.
   * Default: reads `ctx.channel.customFields.vivaMerchantId`.
   */
  resolveMerchantId?: (ctx: VendureRequestContext) => string;

  /**
   * Resolve the Viva source code for the current channel.
   * Default: reads `ctx.channel.customFields.vivaSourceCode ?? 'Default'`.
   */
  resolveSourceCode?: (ctx: VendureRequestContext) => string;

  /**
   * Resolve the ISV platform fee (in minor units) for an order.
   * MUST return a value strictly less than the order total; plugin validates
   * this and throws `VIVA_ISV_AMOUNT_TOO_HIGH` if violated.
   * Default: `() => 0`.
   */
  resolveIsvAmount?: (order: VendureOrder, ctx: VendureRequestContext) => number;

  /**
   * Resolve an optional checkout theme color (hex string, no leading `#`).
   * Appended as `&color=<value>` to the Smart Checkout redirect URL.
   * Default: `() => undefined` (no color param).
   */
  resolveCheckoutColor?: (ctx: VendureRequestContext) => string | undefined;

  /**
   * Required by `POST /isv/v1/accounts` — the URL the merchant is sent back to
   * after completing the Viva-hosted onboarding flow. Probe-verified 2026-05-11:
   * the ISV API rejects the create call when this field is absent.
   *
   * The admin-onboarding controller falls back to the per-request `overrides.returnUrl`
   * if a caller supplies one; otherwise this value is used.
   */
  onboardingReturnUrl: string | ((ctx: VendureRequestContext) => string);

  /**
   * Optional ISV branding shown on Viva's onboarding pages.
   * When supplied, all three of `partnerName`, `logoUrl` (and optionally
   * `primaryColor`) are passed verbatim to `POST /isv/v1/accounts`.
   */
  onboardingBranding?: {
    partnerName: string;
    logoUrl: string;
    /** Hex code, e.g. `#1F2439`. */
    primaryColor?: string;
  };

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

// ---------------------------------------------------------------------------
// Discriminated union — the public type
// ---------------------------------------------------------------------------

/**
 * Configuration passed to `VivaPaymentPlugin.init(options)`.
 *
 * Discriminated union on `mode`. See `VivaMerchantOptions` and `VivaIsvOptions`.
 *
 * @see docs/plans/multi-mode-v0.md §5, §10
 */
export type VivaPaymentPluginOptions = VivaMerchantOptions | VivaIsvOptions;

// ---------------------------------------------------------------------------
// Raw / back-compat input shape — what `init()` accepts
// ---------------------------------------------------------------------------

/**
 * Loose shape `VivaPaymentPlugin.init()` accepts before normalization.
 *
 * - `mode` is optional — defaults to `'merchant'` with a startup warning (or
 *   auto-detected as `'isv'` when ISV-only fields are present).
 * - `clientId` / `clientSecret` may be replaced by their deprecated aliases
 *   `isvClientId` / `isvClientSecret` (one-minor back-compat, removal in 0.3.0).
 *
 * Callers may pass any mix of merchant + ISV fields here; `init()` validates +
 * narrows to the strict `VivaPaymentPluginOptions` union.
 */
export interface VivaPaymentPluginInitInput
  extends Partial<Omit<VivaCommonOptions, 'clientId' | 'clientSecret'>> {
  mode?: VivaMode;

  /** Preferred name (0.2.0+). */
  clientId?: string;
  /** Preferred name (0.2.0+). */
  clientSecret?: string;
  /** @deprecated Use `clientId`. Accepted for one minor (removal in 0.3.0). */
  isvClientId?: string;
  /** @deprecated Use `clientSecret`. Accepted for one minor (removal in 0.3.0). */
  isvClientSecret?: string;

  // Merchant-only fields
  sourceCode?: string;
  checkoutColor?: string;

  // ISV-only fields
  resolveMerchantId?: (ctx: VendureRequestContext) => string;
  resolveSourceCode?: (ctx: VendureRequestContext) => string;
  resolveIsvAmount?: (order: VendureOrder, ctx: VendureRequestContext) => number;
  resolveCheckoutColor?: (ctx: VendureRequestContext) => string | undefined;
  onboardingReturnUrl?: string | ((ctx: VendureRequestContext) => string);
  onboardingBranding?: VivaIsvOptions['onboardingBranding'];
  reseller?: VivaIsvOptions['reseller'];
}
