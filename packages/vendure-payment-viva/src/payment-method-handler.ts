/**
 * payment-method-handler.ts — Vendure PaymentMethodHandler for Viva Wallet ISV.
 *
 * Handler code: 'viva'
 * Storefront calls: addPaymentToOrder({ method: 'viva' })
 * Plan state contract: createPayment returns 'Created' (D3, §2)
 *
 * @see docs/plans/vendure-plugin-v0.md §"API Surface — PaymentMethodHandler operations"
 * @see docs/plans/vendure-plugin-v0.md §"Architecture Decisions D3 + D5 + D11"
 */

import { PaymentMethodHandler, Logger, LanguageCode } from '@vendure/core';
import type { Injector, RequestContext } from '@vendure/core';
import { IsvHttpClient } from '@sakeetech/viva-payments-core/isv';
import { Payments } from '@sakeetech/viva-payments-core/payments';
import { BasicAuthClient } from '@sakeetech/viva-payments-core/legacy';
import {
  FastRefundClient,
  resolveRefundStrategy,
} from '@sakeetech/viva-payments-core/refunds';
import {
  VivaApiError,
  VivaAuthError,
} from '@sakeetech/viva-payments-core/errors';
import type { MerchantId } from '@sakeetech/viva-payments-core/types';
import type {
  VivaPaymentPluginOptions,
  VivaMerchantOptions,
} from './types.js';
import type { VivaOAuth2Strategy } from './providers/viva-oauth2-strategy.provider.js';
import { StateMachineService } from './services/state-machine.service.js';
import { VivaPluginError } from './util/error-envelope.js';
import { alphaToNumeric } from './util/currency.js';
import { substitute } from './util/url-template.js';
import {
  VIVA_PLUGIN_OPTIONS,
  VIVA_OAUTH2_STRATEGY_TOKEN,
  VIVA_LOG_CONTEXT,
} from './constants.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Latency log threshold in ms — log warning when Viva call exceeds this. */
const VIVA_LATENCY_WARN_MS = 1200;

/**
 * Lifespan of a Viva payment order, in seconds. The plugin does not send a
 * `paymentTimeout` on createOrder, so Viva applies its documented default of
 * 1800s (30 min) before the order expires to `OrdersOrderCodeNotFound`.
 * @see docs/internal/payment-api.yaml:14478 (paymentTimeout default 1800s)
 */
const VIVA_ORDER_TTL_SECONDS = 1800;

/**
 * Safety margin (ms) subtracted from a cached order's computed expiry before
 * reuse. Prevents handing the storefront a redirect that dies seconds later;
 * a row inside this window is re-minted rather than reused.
 */
const VIVA_ORDER_EXPIRY_SKEW_MS = 60_000;

/** Terminal statuses — cannot cancel a payment in these states. */
const TERMINAL_STATUSES = new Set(['captured', 'refunded', 'partially_refunded', 'failed', 'cancelled']);

/**
 * Default Smart Checkout source code used when neither the channel custom
 * field `vivaSourceCode` nor `config.sourceCode` (merchant mode) is set.
 *
 * @see references/viva-docs/md/payment-source-for-isv.txt:101
 */
const DEFAULT_SOURCE_CODE = 'Default';

/**
 * Viva createOrder field length limits (per the create-order OpenAPI body).
 * Values are clamped before transmission so an over-long order code or name
 * never trips a 400.
 */
const MERCHANT_TRNS_MAX = 50;
const CUSTOMER_TRNS_MAX = 255;
const CUSTOMER_FULL_NAME_MAX = 100;

// ---------------------------------------------------------------------------
// Module-level singletons (set in init)
// ---------------------------------------------------------------------------

let _options: VivaPaymentPluginOptions | undefined;
let _oauth2: VivaOAuth2Strategy | undefined;
let _stateMachine: StateMachineService | undefined;

/**
 * Build the mode-aware `Payments` client.
 *
 * In merchant mode the URL paths emitted by `Payments` do NOT include the
 * `/isv` segment and do NOT carry `merchantId={uuid}` as a query parameter.
 * The class silently ignores `opts.merchantId` when constructed with
 * `mode: 'merchant'` — adapter call sites may pass either undefined or the
 * configured `legacyMerchantId` and behaviour is identical.
 *
 * @see docs/plans/multi-mode-v0.md §9
 */
function buildPaymentsClient(
  options: VivaPaymentPluginOptions,
  oauth2: VivaOAuth2Strategy,
): Payments {
  const client = new IsvHttpClient({
    environment: options.environment,
    authStrategy: oauth2,
  });
  // Legacy Basic-auth client used by `Payments.refundPayment` (Standard refund).
  // Probe-verified 2026-04-25 (F1): POST /checkout/v2/transactions/{id} → 405.
  // Refund must use the legacy host with Basic auth (legacyMerchantId:legacyApiKey).
  // @see references/viva-docs/md/tut-create-recurring-payment.txt:288
  const legacyClient = buildLegacyClient(options);
  return new Payments({
    mode: options.mode,
    client,
    legacyClient,
  });
}

/**
 * Build the legacy Basic-auth client — same shape in both modes.
 *
 * `authVariant: 'merchant'` (the default) covers both modes' refund path; the
 * `'reseller'` variant is only needed for IsvSources (POST /api/sources) and
 * the payment handler does not call that endpoint.
 *
 * @see docs/AUTH.md §6.2
 */
function buildLegacyClient(options: VivaPaymentPluginOptions): BasicAuthClient {
  return new BasicAuthClient({
    environment: options.environment,
    merchantId: options.legacyMerchantId,
    apiKey: options.legacyApiKey,
  });
}

/**
 * Build a `FastRefundClient` bound to the OAuth2 acquiring scope.
 *
 * In merchant mode the refund handler uses this client when the resolved
 * strategy is `'fast'`. ISV mode does not use Fast Refund in slice B — kept
 * adjacent so future ISV adoption is one config change away.
 *
 * @see docs/ENDPOINTS.md §4
 */
function buildFastRefundClient(
  options: VivaPaymentPluginOptions,
  oauth2: VivaOAuth2Strategy,
): FastRefundClient {
  const client = new IsvHttpClient({
    environment: options.environment,
    authStrategy: oauth2,
  });
  return new FastRefundClient({ client });
}

function getIsvPayments(): Payments {
  if (_isvPaymentsOverride) return _isvPaymentsOverride;
  if (!_oauth2 || !_options) {
    throw VivaPluginError.internalError('VivaPaymentMethodHandler not initialised. Did you call init()?');
  }
  return buildPaymentsClient(_options, _oauth2);
}

function getFastRefundClient(): FastRefundClient {
  if (_fastRefundOverride) return _fastRefundOverride;
  if (!_oauth2 || !_options) {
    throw VivaPluginError.internalError('VivaPaymentMethodHandler not initialised. Did you call init()?');
  }
  return buildFastRefundClient(_options, _oauth2);
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Resolve the Viva merchantId for the current channel.
 *
 * - ISV mode: reads `resolveMerchantId(ctx)` or `channel.customFields.vivaMerchantId`.
 * - Merchant mode: returns `undefined` — there is no per-channel tenant. The
 *   `Payments` client ignores `opts.merchantId` when constructed with
 *   `mode: 'merchant'`, so adapter-level callers may still pass through.
 */
function resolveMerchantId(
  options: VivaPaymentPluginOptions,
  ctx: RequestContext,
): MerchantId | undefined {
  if (options.mode !== 'isv') return undefined;
  const raw: string | undefined = options.resolveMerchantId
    ? options.resolveMerchantId(ctx as any)
    : ((ctx.channel.customFields as Record<string, unknown>)['vivaMerchantId'] as string | undefined);
  return raw as MerchantId | undefined;
}

/**
 * Resolve the Smart Checkout sourceCode.
 *
 * Resolution order (both modes): channel custom field `vivaSourceCode` →
 * mode-specific fallback.
 *
 * - ISV mode: optional `resolveSourceCode(ctx)` override; default `'Default'`.
 * - Merchant mode: `config.sourceCode ?? 'Default'`.
 *
 * `vivaSourceCode` is registered as a channel custom field in both modes per
 * the multi-mode plan — it is the ONE field that retains meaning in merchant
 * mode (operator can override per-channel without code changes).
 */
function resolveSourceCode(
  options: VivaPaymentPluginOptions,
  ctx: RequestContext,
): string {
  // Per-channel override applies in both modes — drop in if operator set it.
  const channelOverride = (ctx.channel.customFields as Record<string, unknown>)['vivaSourceCode'] as
    | string
    | undefined;
  if (channelOverride) return channelOverride;

  if (options.mode === 'isv') {
    if (options.resolveSourceCode) return options.resolveSourceCode(ctx as any);
    return DEFAULT_SOURCE_CODE;
  }
  // merchant mode
  return options.sourceCode ?? DEFAULT_SOURCE_CODE;
}

/**
 * Resolve the ISV platform fee (minor units) for an order.
 *
 * - ISV mode: defaults to 0, override via `resolveIsvAmount`.
 * - Merchant mode: always 0 (no ISV concept — the wire body strips the field
 *   entirely in merchant mode, so the returned value is irrelevant beyond the
 *   pre-call guard).
 */
function resolveIsvAmount(
  options: VivaPaymentPluginOptions,
  order: { totalWithTax: number; currencyCode: string; id: string | number; code: string; state: string },
  ctx: RequestContext,
): number {
  if (options.mode !== 'isv') return 0;
  if (options.resolveIsvAmount) return options.resolveIsvAmount(order as any, ctx as any);
  return 0;
}

function resolveSuccessUrl(options: VivaPaymentPluginOptions, ctx: RequestContext): string {
  return typeof options.successUrl === 'function' ? options.successUrl(ctx as any) : options.successUrl;
}

function resolveFailureUrl(options: VivaPaymentPluginOptions, ctx: RequestContext): string {
  return typeof options.failureUrl === 'function' ? options.failureUrl(ctx as any) : options.failureUrl;
}

/**
 * Resolve the optional Smart Checkout theme color.
 *
 * - ISV mode: optional `resolveCheckoutColor(ctx)` callback.
 * - Merchant mode: optional `config.checkoutColor` string.
 */
function resolveCheckoutColor(
  options: VivaPaymentPluginOptions,
  ctx: RequestContext,
): string | undefined {
  if (options.mode === 'isv') return options.resolveCheckoutColor?.(ctx as any);
  return options.checkoutColor;
}

/** Order shape carrying the relations Vendure loads for createPayment. */
type OrderWithCustomer = {
  code: string;
  customer?: {
    emailAddress?: string | null;
    firstName?: string | null;
    lastName?: string | null;
    phoneNumber?: string | null;
  } | null;
};

/**
 * Build the Viva createOrder identity fields from the Vendure order.
 *
 * The order passed into `createPayment` is loaded with its `customer` relation
 * (OrderService.getOrderOrThrow default relations include `'customer'`), so the
 * customer scalars are available without an extra query. All fields are
 * conditionally included (omitted when absent) and length-clamped to the Viva
 * createOrder limits. The core `Payments` client maps the typed names to the
 * wire body (`customerEmail → email`, `customerPhone → phone`,
 * `customerFullName → fullName`; `merchantTrns`/`customerTrns` pass through).
 *
 * - `merchantTrns` ← `order.code` (always; merchant-facing, echoed in webhooks
 *   as `EventData.MerchantTrns` for reconciliation cross-checks).
 * - `customerTrns` ← `resolveCustomerTrns(order, ctx)` or `Order <code>`.
 * - `customerEmail`/`customerFullName`/`customerPhone` ← order.customer (when set).
 *
 * @see references/viva-docs/md/isv-partner-program.txt:104 (create-order body)
 */
function buildOrderIdentity(
  options: VivaPaymentPluginOptions,
  order: OrderWithCustomer,
  ctx: RequestContext,
): {
  merchantTrns: string;
  customerTrns: string;
  customerEmail?: string;
  customerFullName?: string;
  customerPhone?: string;
} {
  const customerTrnsRaw = options.resolveCustomerTrns
    ? options.resolveCustomerTrns(order as any, ctx as any)
    : `Order ${order.code}`;

  const identity: {
    merchantTrns: string;
    customerTrns: string;
    customerEmail?: string;
    customerFullName?: string;
    customerPhone?: string;
  } = {
    merchantTrns: order.code.slice(0, MERCHANT_TRNS_MAX),
    customerTrns: customerTrnsRaw.slice(0, CUSTOMER_TRNS_MAX),
  };

  const customer = order.customer;
  if (customer) {
    if (customer.emailAddress) identity.customerEmail = customer.emailAddress;
    const fullName = `${customer.firstName ?? ''} ${customer.lastName ?? ''}`.trim();
    if (fullName) identity.customerFullName = fullName.slice(0, CUSTOMER_FULL_NAME_MAX);
    if (customer.phoneNumber) identity.customerPhone = customer.phoneNumber;
  }

  return identity;
}

/**
 * Stable idempotency key for (channelId, orderId, amountMinor, currencyCode).
 * D11: used as both Idempotency-Key header value and pending-row lookup key.
 * Vendure does NOT expose a real paymentId inside createPayment — orderId is
 * the closest stable identifier available at that point.
 *
 * TODO(impl): If a future Vendure version passes the payment ID into createPayment,
 * switch to (channelId, paymentId) here.
 */
function buildIdempotencyKey(channelId: string | number, orderId: string | number, amountMinor: number, currencyCode: string): string {
  return `viva:${channelId}:${orderId}:${amountMinor}:${currencyCode}`;
}

/**
 * Build the Smart Checkout redirect URL.
 * Demo: https://demo.vivapayments.com/web/checkout?ref={orderCode}
 * Production: https://www.vivapayments.com/web/checkout?ref={orderCode}
 */
function buildCheckoutUrl(environment: 'demo' | 'production', orderCode: bigint, color?: string): string {
  const host = environment === 'production' ? 'www.vivapayments.com' : 'demo.vivapayments.com';
  let url = `https://${host}/web/checkout?ref=${orderCode}`;
  if (color) {
    url += `&color=${color.replace(/^#/, '')}`;
  }
  return url;
}

/** Map a VivaApiError to VivaPluginError.apiError with conditional fields. */
function mapApiError(err: VivaApiError): never {
  const opts: Parameters<typeof VivaPluginError.apiError>[0] = { message: err.message };
  if (err.vivaCode !== undefined) opts.vivaErrorCode = Number(err.vivaCode);
  if (err.message) opts.vivaErrorMessage = err.message;
  opts.cause = err;
  throw VivaPluginError.apiError(opts);
}

/** Returns true when the error indicates a Viva-side 5xx / auth / network failure. */
function isRetryableVivaError(err: unknown): err is VivaAuthError | VivaApiError {
  if (err instanceof VivaAuthError) return true;
  if (err instanceof VivaApiError && err.httpStatus !== undefined && err.httpStatus >= 500) return true;
  return false;
}

/**
 * Returns true when a cancelOrder failure means the Viva order is already gone
 * — HTTP 404 `OrdersOrderCodeNotFound` (expired, never created, or already
 * voided). There is nothing left to void, so for cancellation this is a
 * success-equivalent: the local Payment must still transition Created →
 * Cancelled so the order is freed for retry (#14). Viva's cancelOrder is
 * idempotent for already-cancelled/captured orders (those return a normal
 * response, not a 404), so a 404 specifically signals the order code is gone.
 */
function isOrderAlreadyGoneVivaError(err: unknown): err is VivaApiError {
  return err instanceof VivaApiError && err.httpStatus === 404;
}

// ---------------------------------------------------------------------------
// Test injection — allows unit tests to bypass NestJS DI
// ---------------------------------------------------------------------------

/** @internal Test-only: inject dependencies without NestJS DI. */
export function _testInjectDeps(opts: {
  options: VivaPaymentPluginOptions;
  oauth2: VivaOAuth2Strategy;
  stateMachine: StateMachineService;
  isvPayments?: Payments;
  fastRefundClient?: FastRefundClient;
}): void {
  _options = opts.options;
  _oauth2 = opts.oauth2;
  _stateMachine = opts.stateMachine as any;
  // Always reset overrides; only set if explicitly provided.
  _isvPaymentsOverride = opts.isvPayments;
  _fastRefundOverride = opts.fastRefundClient;
}

let _isvPaymentsOverride: Payments | undefined;
let _fastRefundOverride: FastRefundClient | undefined;

// ---------------------------------------------------------------------------
// PaymentMethodHandler
// ---------------------------------------------------------------------------

export const vivaPaymentMethodHandler = new PaymentMethodHandler({
  code: 'viva',
  description: [
    {
      languageCode: LanguageCode.en,
      value: 'Viva Wallet — Smart Checkout (ISV)',
    },
  ],
  args: {},

  // -------------------------------------------------------------------------
  // init — resolve injected services from NestJS DI
  // -------------------------------------------------------------------------
  init(injector: Injector): void {
    _options = injector.get<VivaPaymentPluginOptions>(VIVA_PLUGIN_OPTIONS);
    _oauth2 = injector.get<VivaOAuth2Strategy>(VIVA_OAUTH2_STRATEGY_TOKEN);
    _stateMachine = injector.get(StateMachineService);
  },

  // -------------------------------------------------------------------------
  // createPayment
  // -------------------------------------------------------------------------
  async createPayment(ctx, order, amount, _args, _metadata) {
    const options = _options!;
    const stateMachine = _stateMachine!;

    // Step 1: resolve merchantId.
    // - ISV mode: required; resolved per channel.
    // - Merchant mode: undefined — `Payments` ignores opts.merchantId when
    //   constructed with mode='merchant'. We still record `legacyMerchantId`
    //   on the stored row for ops/audit consistency.
    const merchantId = resolveMerchantId(options, ctx);
    if (options.mode === 'isv' && !merchantId) {
      throw VivaPluginError.channelMisconfigured();
    }

    // Step 2: check vivaPayoutsEnabled gate — ISV-only.
    // In merchant mode there's no onboarding flip; this custom field is
    // meaningless and must not gate the payment.
    if (options.mode === 'isv') {
      const payoutsEnabled = (ctx.channel.customFields as Record<string, unknown>)['vivaPayoutsEnabled'];
      if (payoutsEnabled === false) {
        throw VivaPluginError.accountNotVerified();
      }
    }

    // Step 3: resolve sourceCode (mode-aware — channel override → fallback).
    const sourceCode = resolveSourceCode(options, ctx);

    // Step 4: resolve isvAmount (always 0 in merchant mode).
    const isvAmount = resolveIsvAmount(options, order as any, ctx);

    // Step 5: isvAmount guard — only meaningful in ISV mode (merchant mode
    // returns 0 unconditionally, so this guard never fires there).
    if (isvAmount >= amount) {
      throw VivaPluginError.isvAmountTooHigh(isvAmount, amount);
    }

    // Step 6: resolve checkout color (optional, mode-aware).
    const color = resolveCheckoutColor(options, ctx);

    // Step 7: resolve redirect URL templates
    const successUrlTemplate = resolveSuccessUrl(options, ctx);
    const failureUrlTemplate = resolveFailureUrl(options, ctx);

    // Step 8+9: idempotency key & INSERT-OR-NOTHING pending row.
    // Vendure does NOT pass a paymentId into createPayment (assigned post-return).
    // D11 fallback: key on (channelId, orderId, amountMinor, currencyCode).
    // orderId is used as the paymentId column proxy value.
    const idempotencyKey = buildIdempotencyKey(ctx.channelId, order.id, amount, order.currencyCode);

    // Row-stored merchant id:
    //   ISV mode → resolved per-channel value.
    //   Merchant mode → configured `legacyMerchantId` (ops/audit only; the wire
    //                   call does not include merchantId in merchant mode).
    const storedMerchantId: string =
      options.mode === 'isv'
        ? (merchantId as string)
        : options.legacyMerchantId;

    const { row, wasInserted } = await stateMachine.upsertPendingTransaction(ctx, {
      channelId: ctx.channelId,
      paymentId: order.id,  // proxy until real paymentId available post-return
      idempotencyKey,
      amountMinor: BigInt(amount),
      currencyCode: order.currencyCode,
      isvAmountMinor: BigInt(isvAmount),
    });

    // Idempotency: existing row with vivaOrderCode → reuse its redirect URL,
    // but ONLY while the underlying Viva order is still alive. Viva orders
    // expire (default 1800s) to OrdersOrderCodeNotFound while the local row
    // never does, so a blind reuse hands a returning customer a dead checkout
    // (issue: cached redirectUrl for expired Viva order). We treat the row as
    // a pointer, not the source of truth: reuse only if the stored `expiresAt`
    // is still in the future (minus a skew margin); otherwise fall through and
    // mint a fresh order, overwriting the row. The local row remains the dedup
    // authority for rapid double-submits because Viva does NOT honour the
    // Idempotency-Key header server-side (probe F2 2026-04-25, docs/ENDPOINTS.md),
    // so we cannot drop the cache — only bound its lifetime.
    if (!wasInserted && row.vivaOrderCode) {
      const meta = row.metadata as Record<string, unknown>;
      const existingRedirect = meta['redirectUrl'] as string | undefined;
      const expiresAt = typeof meta['expiresAt'] === 'number' ? (meta['expiresAt'] as number) : undefined;
      // A row predating this fix has no `expiresAt`; treat unknown expiry as
      // expired and re-mint (correctness over a transient double-submit window).
      const stillLive = expiresAt !== undefined && Date.now() < expiresAt - VIVA_ORDER_EXPIRY_SKEW_MS;
      if (existingRedirect && stillLive) {
        Logger.info(`[createPayment] Idempotency hit for order ${String(order.id)} — returning cached redirect URL.`, VIVA_LOG_CONTEXT);
        return {
          amount,
          state: 'Created' as const,
          metadata: {
            redirectUrl: existingRedirect,
            vivaOrderCode: row.vivaOrderCode,
            vivaMerchantId: storedMerchantId,
          },
        };
      }
      Logger.info(
        `[createPayment] Cached Viva order for ${String(order.id)} is expired or unverifiable — minting a fresh order.`,
        VIVA_LOG_CONTEXT,
      );
    }

    // Step 10: call Viva createOrder.
    // - ISV mode → POST /checkout/v2/isv/orders?merchantId={uuid} with isvAmount.
    // - Merchant mode → POST /checkout/v2/orders (no merchantId query, no isvAmount in body).
    // The mode branch is entirely inside the `Payments` class — adapter passes
    // `merchantId` either way; merchant-mode Payments silently drops it.
    const isvPayments = getIsvPayments();
    const currencyCode = alphaToNumeric(order.currencyCode);

    const callStart = Date.now();
    let orderCode: bigint;
    try {
      const createOpts: { merchantId?: MerchantId; idempotencyKey: string } = {
        idempotencyKey,
        ...(merchantId !== undefined ? { merchantId } : {}),
      };
      // Customer identity + merchant reference, drawn from the order already in
      // scope (its `customer` relation is loaded by Vendure). Tags the Viva
      // transaction with the Vendure order code, pre-fills the Smart Checkout
      // page, and lets Viva send its receipt + 3DS email hint. See issue #11.
      const identity = buildOrderIdentity(options, order as unknown as OrderWithCustomer, ctx);

      const response = await isvPayments.createOrder(
        {
          amount: BigInt(amount),
          currencyCode,
          sourceCode,
          ...identity,
          // ISV platform fee (minor units) — already resolved + guarded above.
          // Verified against the Viva create-order OpenAPI body: `isvAmount` is
          // "the amount paid out to the ISV partner", NOT added to `amount` but
          // included in it (the merchant receives amount − isvAmount). The
          // `Payments` client emits it ONLY in mode:'isv' and strips it in
          // merchant mode. We omit it when 0 (no fee) so a no-commission ISV
          // order never trips Viva's documented `minimum` (30) on the field.
          // @see docs/internal/payment-api.yaml (create-order body: isvAmount)
          ...(isvAmount > 0 ? { isvAmount: BigInt(isvAmount) } : {}),
        },
        createOpts,
      );
      // Viva normally returns an OrderCode; guard the anomalous empty response
      // (e.g. an ISV account configured as its own sub-merchant) so it surfaces
      // as a mappable VIVA_API_ERROR instead of a `.toString()` TypeError → 500.
      if (response.orderCode == null) {
        Logger.error(
          `[createPayment] Viva createOrder returned no orderCode for order ${String(order.id)}: ${JSON.stringify(response)}`,
          VIVA_LOG_CONTEXT,
        );
        throw VivaPluginError.apiError({ message: 'Viva createOrder returned no orderCode.' });
      }
      orderCode = response.orderCode;
    } catch (err) {
      if (isRetryableVivaError(err)) {
        throw VivaPluginError.authDown(err instanceof Error ? err.message : String(err), err);
      }
      if (err instanceof VivaApiError) {
        mapApiError(err);
      }
      throw err;
    }

    const elapsed = Date.now() - callStart;
    if (elapsed > VIVA_LATENCY_WARN_MS) {
      Logger.warn(
        `[createPayment] Viva createOrder took ${elapsed}ms (budget: ${VIVA_LATENCY_WARN_MS}ms) for order ${String(order.id)}.`,
        VIVA_LOG_CONTEXT,
      );
    }

    // Step 12: construct redirect URL
    const orderCodeStr = orderCode.toString();
    const redirectUrl = buildCheckoutUrl(options.environment, orderCode, color);

    // Step 13: substitute {orderCode} in success/failure URLs and store on row metadata
    const successUrl = substitute(successUrlTemplate, { orderCode: orderCodeStr });
    const failureUrl = substitute(failureUrlTemplate, { orderCode: orderCodeStr });

    // Stamp the order's expiry so a later idempotency hit can tell a live
    // cached redirect from a dead one. Approximated from the Viva default
    // paymentTimeout (the plugin does not override it); the skew margin on
    // reuse absorbs minting/clock drift.
    const expiresAt = Date.now() + VIVA_ORDER_TTL_SECONDS * 1000;
    const rowMetadata: Record<string, unknown> = {
      idempotencyKey,
      redirectUrl,
      successUrl,
      failureUrl,
      vivaMerchantId: storedMerchantId,
      expiresAt,
    };
    await stateMachine.setOrderCode(ctx, row.id, orderCodeStr, rowMetadata);

    // Step 14: return Created state + redirectUrl in metadata
    return {
      amount,
      state: 'Created' as const,
      metadata: {
        redirectUrl,
        vivaOrderCode: orderCodeStr,
        vivaMerchantId: storedMerchantId,
        public: {
          redirectUrl,
        },
      },
    };
  },

  // -------------------------------------------------------------------------
  // settlePayment — invoked by webhook worker job (V7), NOT by storefront.
  //
  // Mode-agnostic: pure DB mutation (mark viva_transaction row 'captured').
  // The webhook worker has already validated with Viva via retrieveTransaction
  // before invoking the state machine, so there is no Viva API call here in
  // either mode.
  // -------------------------------------------------------------------------
  async settlePayment(ctx, _order, payment, _args) {
    const stateMachine = _stateMachine!;

    // Idempotent: already settled → no-op
    if (payment.state === 'Settled') {
      return { success: true as const };
    }

    const row = await stateMachine.getVivaTransaction(ctx, ctx.channelId, payment.id);
    if (row) {
      const existingMeta = row.metadata as Record<string, unknown>;
      await stateMachine.setStatus(ctx, row.id, 'captured', {
        ...existingMeta,
        settledAt: new Date().toISOString(),
      });
    }

    return {
      success: true as const,
      metadata: { settledAt: new Date().toISOString() },
    };
  },

  // -------------------------------------------------------------------------
  // cancelPayment — invoked by Shop API mutation on ?paymentCancelled=1 (V8)
  // -------------------------------------------------------------------------
  async cancelPayment(ctx, _order, payment, _args) {
    const options = _options!;
    const stateMachine = _stateMachine!;

    // Step 1: load transaction row
    const row = await stateMachine.getVivaTransaction(ctx, ctx.channelId, payment.id);

    // Step 2: missing row or no orderCode
    if (!row || !row.vivaOrderCode) {
      throw VivaPluginError.paymentNotCancellable('No Viva order code found — payment may not have been initiated.');
    }

    // Step 3: already terminal
    if (TERMINAL_STATUSES.has(row.status)) {
      throw VivaPluginError.paymentNotCancellable(`Payment is already in terminal state: ${row.status}.`);
    }

    // Step 4: resolve merchantId (ISV mode only — fallback to metadata-stored
    // value for robustness when the channel custom field was unset after the
    // row was created). Merchant mode passes undefined; `Payments` silently
    // drops it from the DELETE URL.
    let merchantId: MerchantId | undefined;
    if (options.mode === 'isv') {
      merchantId =
        (resolveMerchantId(options, ctx) ??
          ((row.metadata as Record<string, unknown>)['vivaMerchantId'] as MerchantId | undefined)) as MerchantId;
      if (!merchantId) {
        throw VivaPluginError.channelMisconfigured();
      }
    }

    // Step 5: call Viva cancelOrder.
    // - ISV mode: DELETE /checkout/v2/orders/{oc}?merchantId={uuid}.
    // - Merchant mode: DELETE /checkout/v2/orders/{oc}.
    const isvPayments = getIsvPayments();
    const cancelOpts: { merchantId?: MerchantId } =
      merchantId !== undefined ? { merchantId } : {};
    try {
      await isvPayments.cancelOrder(BigInt(row.vivaOrderCode), cancelOpts);
    } catch (err) {
      if (isRetryableVivaError(err)) {
        throw VivaPluginError.authDown(err instanceof Error ? err.message : String(err), err);
      }
      // The Viva order is already gone (404 OrdersOrderCodeNotFound — expired or
      // otherwise non-voidable). There is nothing left to void, so do NOT hard-fail:
      // fall through and still cancel the local Payment (#14). Leaving it `Created`
      // would let Vendure's totalCoveredByPayments() keep counting it, dropping the
      // retry's amountToPay to 0 (→ createPayment throws isvAmountTooHigh) or to a
      // partial remainder (→ a second stacked Created payment). Only genuinely
      // non-retryable, still-present errors propagate.
      if (!isOrderAlreadyGoneVivaError(err)) {
        if (err instanceof VivaApiError) {
          mapApiError(err);
        }
        throw err;
      }
      Logger.info(
        `[cancelPayment] Viva order ${row.vivaOrderCode} already gone (HTTP 404) — cancelling the local payment so the order can be retried.`,
        VIVA_LOG_CONTEXT,
      );
    }

    // Step 6: update row status
    const existingMeta = row.metadata as Record<string, unknown>;
    await stateMachine.setStatus(ctx, row.id, 'cancelled', {
      ...existingMeta,
      cancelledAt: new Date().toISOString(),
    });

    return { success: true as const };
  },

  // -------------------------------------------------------------------------
  // createRefund — invoked by Vendure admin refund flow
  // -------------------------------------------------------------------------
  async createRefund(ctx, input, amount, _order, payment, _args) {
    const options = _options!;
    const stateMachine = _stateMachine!;

    // Step 1: load transaction row
    const row = await stateMachine.getVivaTransaction(ctx, ctx.channelId, payment.id);
    if (!row) {
      throw VivaPluginError.refundRejected('VivaTransaction row not found for this payment.');
    }

    // Step 2: status must be captured
    if (row.status !== 'captured') {
      throw VivaPluginError.refundRejected(
        `Payment not yet captured (status: ${row.status}). Refund requires captured status.`,
      );
    }

    // Step 3: need vivaTransactionId (populated by webhook worker V7)
    if (!row.vivaTransactionId) {
      throw VivaPluginError.refundRejected('Viva transaction ID not yet known — webhook may be pending.');
    }

    // Step 4: determine amountMinor (omit for full refund per SDK contract)
    const isFullRefund = input.amount === payment.amount;
    const amountMinor: bigint | undefined = isFullRefund ? undefined : BigInt(amount);

    // Step 5: resolve merchantId for Standard refund leg.
    // - ISV mode: required (resolved from channel + row metadata fallback).
    // - Merchant mode: pass the configured legacyMerchantId. The Payments
    //   method requires a value at the type level but does NOT encode it in
    //   the URL — the legacy refund endpoint authenticates via Basic auth on
    //   the host, not via a path/query param.
    let merchantId: MerchantId;
    if (options.mode === 'isv') {
      const resolved =
        (resolveMerchantId(options, ctx) ??
          ((row.metadata as Record<string, unknown>)['vivaMerchantId'] as MerchantId | undefined)) as MerchantId;
      if (!resolved) {
        throw VivaPluginError.channelMisconfigured();
      }
      merchantId = resolved;
    } else {
      merchantId = options.legacyMerchantId as MerchantId;
    }

    const refundIdempotencyKey = `viva:refund:${String(row.id)}:${amount}`;

    // Step 6: pre-check legacy creds. Refunds in both modes ultimately depend
    // on the legacy host (Standard refund directly; Fast Refund falls back to
    // Standard on 403 when strategy==='auto'). Without these creds the refund
    // cannot proceed.
    // @see references/viva-docs/md/tut-create-recurring-payment.txt:288
    if (!options.legacyMerchantId || !options.legacyApiKey) {
      throw VivaPluginError.refundRejected(
        'Viva refund requires legacyMerchantId and legacyApiKey in plugin options. ' +
          'Probe-verified 2026-04-25: POST /checkout/v2/transactions/{id} returns 405. ' +
          'Only the legacy host with Basic auth works for Standard refund.',
      );
    }

    const isvPayments = getIsvPayments();

    // Step 7: branch refund path on mode.
    //   ISV mode      → Standard refund only (Payments.refundPayment).
    //   Merchant mode → resolveRefundStrategy + FastRefundClient, with
    //                   auto-fallback to Standard on HTTP 403 (auto only).
    let refundResponse: { transactionId: string };
    if (options.mode === 'isv') {
      refundResponse = await callStandardRefund(
        isvPayments,
        row.vivaTransactionId,
        merchantId,
        amountMinor,
        refundIdempotencyKey,
      );
    } else {
      refundResponse = await refundMerchantMode({
        options,
        isvPayments,
        fastRefundClient: getFastRefundClient(),
        vivaTransactionId: row.vivaTransactionId,
        amountMinor,
        fullAmountMinor: BigInt(payment.amount),
        isFullRefund,
        refundIdempotencyKey,
        rowMerchantId: merchantId,
      });
    }

    // Step 8: update row status
    const newStatus = isFullRefund ? 'refunded' as const : 'partially_refunded' as const;
    const existingMeta = row.metadata as Record<string, unknown>;
    const refundedSoFar = (existingMeta['refundedAmountMinor'] as number | undefined) ?? 0;
    await stateMachine.setStatus(ctx, row.id, newStatus, {
      ...existingMeta,
      refundedAmountMinor: refundedSoFar + amount,
      lastRefundTransactionId: refundResponse.transactionId,
      lastRefundAt: new Date().toISOString(),
    });

    // Step 9: return per Vendure refund contract
    return {
      state: 'Settled' as const,
      metadata: {
        vivaRefundResponse: { transactionId: refundResponse.transactionId },
      },
    };
  },
});

// ---------------------------------------------------------------------------
// Refund helpers (file-level — exported only via the handler)
// ---------------------------------------------------------------------------

/**
 * Call the Standard (legacy/Basic-auth) refund path via `Payments.refundPayment`.
 *
 * Wraps the legacy refund call with the adapter-level error envelope:
 *   - 5xx / auth → VIVA_AUTH_DOWN (retryable=true).
 *   - 4xx        → VIVA_REFUND_REJECTED (retryable=false).
 *
 * @see references/viva-docs/md/tut-create-recurring-payment.txt:288
 */
async function callStandardRefund(
  isvPayments: Payments,
  vivaTransactionId: string,
  merchantId: MerchantId,
  amountMinor: bigint | undefined,
  refundIdempotencyKey: string,
): Promise<{ transactionId: string }> {
  try {
    const opts: { merchantId: MerchantId; idempotencyKey: string; amountMinor?: bigint } = {
      merchantId,
      idempotencyKey: refundIdempotencyKey,
    };
    if (amountMinor !== undefined) opts.amountMinor = amountMinor;
    const refundResponse = await isvPayments.refundPayment(vivaTransactionId as any, opts);
    return { transactionId: refundResponse.transactionId as string };
  } catch (err) {
    if (isRetryableVivaError(err)) {
      throw VivaPluginError.authDown(err instanceof Error ? err.message : String(err), err);
    }
    if (err instanceof VivaApiError) {
      throw VivaPluginError.refundRejected(err.message, err);
    }
    throw err;
  }
}

/**
 * Merchant-mode refund routing — Fast vs Standard with auto-fallback.
 *
 * Flow:
 *   1. retrieveTransaction → cardType (drives strategy decision).
 *   2. resolveRefundStrategy(config.refundStrategy ?? 'auto', { cardType, CNP: true }).
 *      Smart Checkout is always card-not-present (CNP).
 *   3. decision.kind === 'fast'  → FastRefundClient.refund:
 *        - 403 + strategy === 'fast'  → VIVA_REFUND_REJECTED with the
 *          "fast does not fall back" message (mirrors medusa slice B).
 *        - 403 + strategy === 'auto'  → fall through to Standard refund.
 *        - any other error            → wrap via the standard error envelope.
 *   4. decision.kind === 'standard' → callStandardRefund.
 *
 * @see docs/ENDPOINTS.md §4
 * @see docs/plans/multi-mode-v0.md §8.5a
 * @see references/payment-api.yaml:9255 (Fast Refund 403 semantics)
 */
async function refundMerchantMode(params: {
  options: VivaMerchantOptions;
  isvPayments: Payments;
  fastRefundClient: FastRefundClient;
  vivaTransactionId: string;
  amountMinor: bigint | undefined;
  fullAmountMinor: bigint;
  isFullRefund: boolean;
  refundIdempotencyKey: string;
  rowMerchantId: MerchantId;
}): Promise<{ transactionId: string }> {
  const {
    options,
    isvPayments,
    fastRefundClient,
    vivaTransactionId,
    amountMinor,
    fullAmountMinor,
    isFullRefund,
    refundIdempotencyKey,
    rowMerchantId,
  } = params;

  const configuredStrategy = options.refundStrategy ?? 'auto';

  // Step 1: look up cardType. Failure → log + proceed; strategy falls through
  // to the `auto-no-card-info` branch (which routes to Standard).
  let cardType: string | undefined;
  try {
    const tx = await isvPayments.retrieveTransaction(vivaTransactionId as any);
    cardType = tx.cardType;
  } catch (err) {
    Logger.warn(
      `[createRefund] retrieveTransaction failed for '${vivaTransactionId}': ` +
        `${err instanceof Error ? err.message : String(err)}. ` +
        `Refund strategy will route via 'auto-no-card-info' (Standard).`,
      VIVA_LOG_CONTEXT,
    );
  }

  // Step 2: resolve strategy.
  const decision = resolveRefundStrategy(configuredStrategy, {
    ...(cardType !== undefined ? { cardType } : {}),
    isCardNotPresent: true, // Smart Checkout — always CNP
  });

  if (decision.kind === 'fast') {
    // Fast Refund requires an explicit amount (no full-refund-by-omission).
    const fastAmount: bigint = isFullRefund ? fullAmountMinor : (amountMinor as bigint);
    try {
      const result = await fastRefundClient.refund({
        transactionId: vivaTransactionId as any,
        amount: fastAmount as any,
        sourceCode: options.sourceCode ?? DEFAULT_SOURCE_CODE,
        merchantTrns: refundIdempotencyKey,
        idempotencyKey: refundIdempotencyKey,
      });
      return { transactionId: result.transactionId as string };
    } catch (err) {
      const is403 = err instanceof VivaApiError && err.httpStatus === 403;
      if (is403 && configuredStrategy === 'fast') {
        // Explicit `fast` opt-in does not fall back — surface as a distinct
        // code so callers can prompt operators to switch to 'auto' instead of
        // treating it as a generic refund rejection.
        throw VivaPluginError.fastRefundIneligible(undefined, err);
      }
      if (!is403) {
        if (isRetryableVivaError(err)) {
          throw VivaPluginError.authDown(err instanceof Error ? err.message : String(err), err);
        }
        if (err instanceof VivaApiError) {
          throw VivaPluginError.refundRejected(err.message, err);
        }
        throw err;
      }
      // is403 + auto → fall through to Standard refund.
      Logger.info(
        `[createRefund] Fast Refund 403 with strategy='auto' — falling back to Standard refund for ${vivaTransactionId}.`,
        VIVA_LOG_CONTEXT,
      );
    }
  }

  // Standard refund — Payments.refundPayment routes via legacy/Basic auth.
  return callStandardRefund(
    isvPayments,
    vivaTransactionId,
    rowMerchantId,
    amountMinor,
    refundIdempotencyKey,
  );
}
