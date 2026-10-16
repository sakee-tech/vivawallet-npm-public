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
import { classifyCancel } from './util/cancel-guard.js';
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
  // Merchant Basic client for `Payments.refundPayment` (Standard refund:
  // DELETE /api/transactions/{id} on the legacy host). MERCHANT MODE ONLY — in
  // ISV mode there are no Merchant Basic creds and the refund builds a
  // reseller-variant client per-call, so leave this undefined.
  // @see docs/internal/payment-isv-api.yaml:2650
  const legacyClient = options.mode === 'merchant' ? buildLegacyClient(options) : undefined;
  return new Payments({
    mode: options.mode,
    client,
    ...(legacyClient !== undefined ? { legacyClient } : {}),
  });
}

/**
 * Build the merchant-variant legacy Basic-auth client.
 *
 * Used as the construction-time `legacyClient` on `Payments` for MERCHANT mode
 * (Standard refund + webhook-key fetch). ISV-mode refunds do NOT use this — they
 * build a reseller-variant client per-refund via {@link buildResellerLegacyClient}.
 *
 * @see docs/AUTH.md §6.2
 */
function buildLegacyClient(options: VivaPaymentPluginOptions): BasicAuthClient {
  return new BasicAuthClient({
    authVariant: 'merchant',
    environment: options.environment,
    merchantId: options.legacyMerchantId,
    apiKey: options.legacyApiKey,
  });
}

/**
 * Build a reseller-variant legacy Basic-auth client scoped to ONE connected
 * merchant, for the ISV Standard refund (`DELETE /api/transactions/{id}`).
 *
 * The Basic credential is `base64(resellerId:connectedMerchantId:resellerApiKey)`
 * — the `merchantId` slot is the *connected merchant's* UUID (from the
 * transaction), NOT `options.reseller.merchantId`. The reseller creds are the
 * Viva-issued pair (demo/production differ), distinct from dashboard ISV creds.
 *
 * @see docs/internal/payment-isv-api.yaml:2650 (reseller auth structure)
 */
function buildResellerLegacyClient(
  reseller: { resellerId: string; resellerApiKey: string },
  environment: VivaPaymentPluginOptions['environment'],
  connectedMerchantId: string,
): BasicAuthClient {
  return new BasicAuthClient({
    authVariant: 'reseller',
    environment,
    resellerId: reseller.resellerId,
    merchantId: connectedMerchantId,
    resellerApiKey: reseller.resellerApiKey,
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
  /** Test-only: MockAgent-backed reseller client for the ISV refund path. */
  resellerLegacyClient?: BasicAuthClient;
}): void {
  _options = opts.options;
  _oauth2 = opts.oauth2;
  _stateMachine = opts.stateMachine as any;
  // Always reset overrides; only set if explicitly provided.
  _isvPaymentsOverride = opts.isvPayments;
  _fastRefundOverride = opts.fastRefundClient;
  _resellerLegacyClientOverride = opts.resellerLegacyClient;
}

let _isvPaymentsOverride: Payments | undefined;
let _fastRefundOverride: FastRefundClient | undefined;
let _resellerLegacyClientOverride: BasicAuthClient | undefined;

/**
 * Resolve the reseller-variant legacy client for an ISV refund — the test
 * override if injected, else a freshly built client scoped to the connected
 * merchant. @see buildResellerLegacyClient
 */
function getResellerLegacyClient(
  options: VivaPaymentPluginOptions & { reseller: { resellerId: string; resellerApiKey: string } },
  connectedMerchantId: string,
): BasicAuthClient {
  if (_resellerLegacyClientOverride) return _resellerLegacyClientOverride;
  return buildResellerLegacyClient(options.reseller, options.environment, connectedMerchantId);
}

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

    const { row } = await stateMachine.upsertPendingTransaction(ctx, {
      channelId: ctx.channelId,
      paymentId: order.id,  // proxy until real paymentId available post-return
      idempotencyKey,
      amountMinor: BigInt(amount),
      currencyCode: order.currencyCode,
      isvAmountMinor: BigInt(isvAmount),
    });

    // No reuse of a prior Viva order. A Viva Payment Order is a single-use
    // payment intent: its StateId is a one-shot lifecycle (Pending → Expired /
    // Canceled / Paid, all terminal — payment-isv-api.yaml:4482), and it is
    // auto-cancelled once `paymentTimeout` elapses (yaml:6069). So once a
    // customer declines/cancels an attempt, the order is dead — reusing its
    // redirect (as the previous time-only `expiresAt` gate did) sends the retry
    // straight to the hosted failure page (/web2/fail) (public #25). We follow
    // the Vendure Mollie model and mint a fresh order on every createPayment.
    //
    // The local row is NOT a reuse cache — it is the vivaOrderCode → paymentId
    // correlation record the inbound settlement webhook resolves by
    // (findByVivaOrderCode, state-machine.service.ts). `setOrderCode` below
    // overwrites it with the newest code on each mint; this is safe because
    // only the winning (paid) attempt fires a success webhook, and that is
    // always the latest mint. Declined/cancelled/expired attempts fire no
    // success webhook, so their stale codes never need resolving.
    //
    // A genuine double-submit mints two orders; harmless — only one is payable
    // and the loser auto-expires. We do NOT dedup on the row because Viva does
    // NOT honour the createOrder Idempotency-Key header server-side anyway
    // (probe F2 2026-04-25, docs/ENDPOINTS.md), so a row gate bought nothing.

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

    // Overwrite the correlation row with the newest orderCode + redirect. No
    // expiry is stamped: the order is never reused, so its lifespan is Viva's
    // concern, not ours.
    const rowMetadata: Record<string, unknown> = {
      idempotencyKey,
      redirectUrl,
      successUrl,
      failureUrl,
      vivaMerchantId: storedMerchantId,
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

    // Step 2: resolve the Viva order code. Prefer the transaction row, but fall
    // back to the Payment's own metadata (persisted by createPayment) so a
    // legitimately-initiated payment stays cancellable even when the row is
    // missing/lost — the row is not the only record of the order code (#19/#33).
    const paymentMeta = (payment.metadata ?? {}) as Record<string, unknown>;
    const vivaOrderCode =
      row?.vivaOrderCode ?? (paymentMeta['vivaOrderCode'] as string | undefined);
    if (!vivaOrderCode) {
      throw VivaPluginError.paymentNotCancellable('No Viva order code found — payment may not have been initiated.');
    }

    // Step 3: resolve merchantId (ISV mode only — fallback to metadata-stored
    // value for robustness when the channel custom field was unset after the
    // row was created, or when the row itself is missing). Merchant mode does
    // not need it — the Merchant Basic credential already scopes the cancel.
    // Resolved before the terminal-status check because the #26 reconcile below
    // re-verifies the transaction with Viva, which (in ISV mode) needs it too.
    let merchantId: MerchantId | undefined;
    if (options.mode === 'isv') {
      const rowMeta = (row?.metadata ?? {}) as Record<string, unknown>;
      merchantId =
        (resolveMerchantId(options, ctx) ??
          (rowMeta['vivaMerchantId'] as MerchantId | undefined) ??
          (paymentMeta['vivaMerchantId'] as MerchantId | undefined)) as MerchantId;
      if (!merchantId) {
        throw VivaPluginError.channelMisconfigured();
      }
    }

    // Step 4: terminal-status handling, with a desync reconcile.
    //
    // A 'captured' row paired with a Payment that never reached 'Settled' is the
    // #26 desync: the row was stamped captured (a 1796 sibling no-op, or a settle
    // that didn't land on THIS payment) while Vendure left the Payment in `Created`.
    // Blind-refusing here bricks every retry on isvAmountTooHigh(99, 0) — the
    // `Created` payment still counts in totalCoveredByPayments(), so amountToPay
    // drops to 0, and there is no Shop-API escape. Reconcile against Viva instead:
    // re-read the transaction and either complete the order (genuine capture) or
    // free the payment (row was mis-marked).
    if (row && row.status === 'captured' && payment.state !== 'Settled') {
      const txnId = row.vivaTransactionId ?? undefined;
      let reallyCaptured = false;
      if (txnId) {
        try {
          const isvPayments = getIsvPayments();
          const opts = options.mode === 'isv' && merchantId ? { merchantId } : {};
          const tx = await isvPayments.retrieveTransaction(txnId as any, opts);
          // statusId 'F' = the Viva transaction is finished/captured.
          reallyCaptured = tx.statusId === 'F';
        } catch (err) {
          // Transient verify failure → surface as retryable; the storefront can
          // re-attempt the cancel once Viva is reachable, rather than bricking.
          if (isRetryableVivaError(err)) {
            throw VivaPluginError.authDown(err instanceof Error ? err.message : String(err), err);
          }
          // Non-retryable (e.g. 404 — transaction gone): treat as not-captured and
          // free the payment below.
        }
      }

      if (reallyCaptured) {
        // Money was genuinely taken; the order must COMPLETE, not cancel. Drive the
        // stranded Payment `Created → Settled` so it stops blocking and the order
        // reaches PaymentSettled. (Returning a cancel here would leave a captured
        // Viva order with no matching settled Vendure payment.)
        Logger.warn(
          `[cancelPayment] Payment ${String(payment.id)} row is 'captured' and Viva confirms ` +
            `transaction ${String(txnId)} is captured, but the Vendure Payment was still ` +
            `'${payment.state}'. Settling it to resolve the desync (#26).`,
          VIVA_LOG_CONTEXT,
        );
        await stateMachine.transitionPaymentToSettled(ctx, _order.id, payment.id);
        // Cancel is not applicable to a now-settled payment; report failure so the
        // storefront re-reads order state (now PaymentSettled) and moves to confirmation.
        throw VivaPluginError.paymentNotCancellable(
          'Payment was already captured at Viva and has now been settled — order is paid, not cancellable.',
        );
      }

      // Not actually captured → the row was mis-marked. Fall through to the normal
      // cancel path (void the Viva order if still live, then free the Payment) so
      // the order can be retried. Log loud — this is a recovered desync, #26.
      Logger.warn(
        `[cancelPayment] Payment ${String(payment.id)} row is 'captured' but Viva does NOT ` +
          `confirm capture (txn ${String(txnId ?? 'none')}); the row was mis-marked. Freeing the ` +
          `payment so the order can be retried (#26).`,
        VIVA_LOG_CONTEXT,
      );
    } else if (classifyCancel(payment.state) !== 'proceed') {
      // Defensive: the resolver only delegates here for a cancellable Payment
      // (`Created`/`Authorized`), so this branch is normally unreachable. But the
      // handler must never void/transition a Payment that the authoritative
      // Payment.state says is already paid (`Settled`) or terminal
      // (`Cancelled`/`Declined`/`Error`). We key the refusal off Payment.state —
      // NOT the row — so a `Created` payment with a diverged row status (e.g. a
      // mis-marked `cancelled` row, #27) still cancels instead of bricking. The
      // captured/unsettled reconcile is handled by the branch above. The message
      // surfaces the row status when present (the historical desync signal).
      throw VivaPluginError.paymentNotCancellable(
        `Payment is already in terminal state: ${row?.status ?? payment.state}.`,
      );
    }

    // Step 5: call Viva cancelOrder.
    //   DELETE /api/orders/{oc} on the legacy host with Basic auth (the v2/OAuth2
    //   route does not exist — verified 404, see Payments.cancelOrder).
    // - Merchant mode: uses the construction-time Merchant Basic legacyClient.
    // - ISV mode: an ISV never holds the connected merchant's ApiKey, so build a
    //   Reseller-variant client scoped to the connected merchant per-call —
    //   exactly as the Standard refund path does.
    const isvPayments = getIsvPayments();
    const cancelOpts: { merchantId?: MerchantId; legacyClient?: BasicAuthClient } =
      merchantId !== undefined ? { merchantId } : {};
    if (options.mode === 'isv') {
      if (!options.reseller) {
        throw VivaPluginError.channelMisconfigured(
          'ISV cancel requires reseller credentials (options.reseller = { resellerId, ' +
            'merchantId, resellerApiKey }) — the Viva-issued Reseller pair, distinct from ' +
            'the dashboard ISV credentials. Cancel path: DELETE /api/orders/{oc} on the legacy host.',
        );
      }
      cancelOpts.legacyClient = getResellerLegacyClient(
        options as VivaPaymentPluginOptions & {
          reseller: { resellerId: string; resellerApiKey: string };
        },
        merchantId as string,
      );
    }
    try {
      await isvPayments.cancelOrder(BigInt(vivaOrderCode), cancelOpts);
    } catch (err) {
      // Transient Viva failure (5xx / auth / network): surface as retryable so
      // the storefront can re-attempt the cancel. The local Payment stays
      // `Created`, but that is recoverable — a later cancel succeeds — not a
      // permanent brick.
      if (isRetryableVivaError(err)) {
        throw VivaPluginError.authDown(err instanceof Error ? err.message : String(err), err);
      }
      // Any NON-retryable Viva failure — 404 (already gone/expired) OR a 4xx
      // non-cancellable state (already cancelled, locked, transient reject) —
      // means the order cannot be voided through the API. We MUST still free the
      // local Payment: leaving it `Created` keeps Vendure's
      // totalCoveredByPayments() counting it, so the retry's amountToPay drops to
      // 0 and createPayment throws isvAmountTooHigh(isvAmount, 0) — permanently
      // bricking the order with NO Shop-API recovery (the Shop API cannot
      // transition a Payment). The earlier #14 fix freed only the 404 branch;
      // this generalises it to its correct scope (#16).
      //
      // Race-neutral: cancelOrder on an already-CAPTURED order returns success
      // (not an error), so the same capture/settle race already exists on the
      // happy path — broadening the swallow here adds none. A genuinely captured
      // order is caught earlier by the terminal-status guard (Step 3); a late
      // 1796 settle for a force-cancelled Payment fails loud in the webhook
      // worker (operator-visible), never a silent double-charge. The Viva order
      // expires via paymentTimeout regardless, so nothing is left chargeable.
      const detail =
        err instanceof VivaApiError
          ? `HTTP ${err.httpStatus ?? '?'}${err.vivaCode !== undefined ? ` viva=${String(err.vivaCode)}` : ''}: ${err.message}`
          : err instanceof Error
            ? err.message
            : String(err);
      Logger.warn(
        `[cancelPayment] Viva cancelOrder for order ${vivaOrderCode} failed non-retryably (${detail}) — ` +
          `cancelling the local Payment anyway so the order can be retried (#16).`,
        VIVA_LOG_CONTEXT,
      );
    }

    // Step 6: update row status (only if a row exists — when cancelling via
    // payment-metadata fallback there is no row to transition; the Viva order is
    // already voided above, which is what frees the Payment for retry).
    if (row) {
      const existingMeta = row.metadata as Record<string, unknown>;
      await stateMachine.setStatus(ctx, row.id, 'cancelled', {
        ...existingMeta,
        cancelledAt: new Date().toISOString(),
      });
    }

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

    // Step 6: pre-check Basic-auth creds — mode-specific.
    //   - merchant: Standard refund (and Fast→Standard fallback) authenticates
    //     with the Merchant Basic pair (legacyMerchantId + legacyApiKey).
    //   - isv: the refund is `DELETE /api/transactions/{id}` authenticated with
    //     the Viva-issued Reseller pair scoped to the connected merchant. The
    //     Merchant Basic pair is inapplicable — an ISV never holds a connected
    //     merchant's ApiKey.
    // @see docs/internal/payment-isv-api.yaml:2650 (reseller auth)
    if (options.mode === 'isv') {
      if (!options.reseller) {
        throw VivaPluginError.refundRejected(
          'ISV refund requires reseller credentials (options.reseller = { resellerId, ' +
            'merchantId, resellerApiKey }). These are the Viva-issued Reseller ID/API key ' +
            '(demo and production pairs differ; production is obtained from Viva), distinct ' +
            'from the dashboard ISV credentials.',
        );
      }
    } else if (!options.legacyMerchantId || !options.legacyApiKey) {
      throw VivaPluginError.refundRejected(
        'Merchant-mode refund requires legacyMerchantId and legacyApiKey (Merchant Basic auth). ' +
          'Refund path: DELETE /api/transactions/{id} on the legacy host.',
      );
    }

    const isvPayments = getIsvPayments();

    // Step 7: branch refund path on mode.
    //   ISV mode      → Standard refund only (Payments.refundPayment).
    //   Merchant mode → resolveRefundStrategy + FastRefundClient, with
    //                   auto-fallback to Standard on HTTP 403 (auto only).
    let refundResponse: { transactionId: string };
    if (options.mode === 'isv') {
      // Build the reseller-variant client scoped to THIS connected merchant.
      // `options.reseller` presence is guaranteed by the Step 6 pre-check.
      const resellerLegacyClient = getResellerLegacyClient(
        options as VivaPaymentPluginOptions & {
          reseller: { resellerId: string; resellerApiKey: string };
        },
        merchantId,
      );
      refundResponse = await callStandardRefund(
        isvPayments,
        row.vivaTransactionId,
        merchantId,
        amountMinor,
        refundIdempotencyKey,
        resellerLegacyClient,
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
  legacyClientOverride?: BasicAuthClient,
): Promise<{ transactionId: string }> {
  try {
    const opts: {
      merchantId: MerchantId;
      idempotencyKey: string;
      amountMinor?: bigint;
      legacyClient?: BasicAuthClient;
    } = {
      merchantId,
      idempotencyKey: refundIdempotencyKey,
    };
    if (amountMinor !== undefined) opts.amountMinor = amountMinor;
    // ISV mode injects a reseller-variant client scoped to the connected
    // merchant; merchant mode leaves this undefined to use the Merchant Basic
    // client wired at construction time.
    if (legacyClientOverride !== undefined) opts.legacyClient = legacyClientOverride;
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
