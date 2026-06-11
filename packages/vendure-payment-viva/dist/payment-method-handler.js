"use strict";
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
Object.defineProperty(exports, "__esModule", { value: true });
exports.vivaPaymentMethodHandler = void 0;
exports._testInjectDeps = _testInjectDeps;
const core_1 = require("@vendure/core");
const isv_1 = require("@sakeetech/viva-payments-core/isv");
const payments_1 = require("@sakeetech/viva-payments-core/payments");
const legacy_1 = require("@sakeetech/viva-payments-core/legacy");
const refunds_1 = require("@sakeetech/viva-payments-core/refunds");
const errors_1 = require("@sakeetech/viva-payments-core/errors");
const state_machine_service_js_1 = require("./services/state-machine.service.js");
const error_envelope_js_1 = require("./util/error-envelope.js");
const currency_js_1 = require("./util/currency.js");
const url_template_js_1 = require("./util/url-template.js");
const constants_js_1 = require("./constants.js");
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
let _options;
let _oauth2;
let _stateMachine;
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
function buildPaymentsClient(options, oauth2) {
    const client = new isv_1.IsvHttpClient({
        environment: options.environment,
        authStrategy: oauth2,
    });
    // Merchant Basic client for `Payments.refundPayment` (Standard refund:
    // DELETE /api/transactions/{id} on the legacy host). MERCHANT MODE ONLY — in
    // ISV mode there are no Merchant Basic creds and the refund builds a
    // reseller-variant client per-call, so leave this undefined.
    // @see docs/internal/payment-isv-api.yaml:2650
    const legacyClient = options.mode === 'merchant' ? buildLegacyClient(options) : undefined;
    return new payments_1.Payments({
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
function buildLegacyClient(options) {
    return new legacy_1.BasicAuthClient({
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
function buildResellerLegacyClient(reseller, environment, connectedMerchantId) {
    return new legacy_1.BasicAuthClient({
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
function buildFastRefundClient(options, oauth2) {
    const client = new isv_1.IsvHttpClient({
        environment: options.environment,
        authStrategy: oauth2,
    });
    return new refunds_1.FastRefundClient({ client });
}
function getIsvPayments() {
    if (_isvPaymentsOverride)
        return _isvPaymentsOverride;
    if (!_oauth2 || !_options) {
        throw error_envelope_js_1.VivaPluginError.internalError('VivaPaymentMethodHandler not initialised. Did you call init()?');
    }
    return buildPaymentsClient(_options, _oauth2);
}
function getFastRefundClient() {
    if (_fastRefundOverride)
        return _fastRefundOverride;
    if (!_oauth2 || !_options) {
        throw error_envelope_js_1.VivaPluginError.internalError('VivaPaymentMethodHandler not initialised. Did you call init()?');
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
function resolveMerchantId(options, ctx) {
    if (options.mode !== 'isv')
        return undefined;
    const raw = options.resolveMerchantId
        ? options.resolveMerchantId(ctx)
        : ctx.channel.customFields['vivaMerchantId'];
    return raw;
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
function resolveSourceCode(options, ctx) {
    // Per-channel override applies in both modes — drop in if operator set it.
    const channelOverride = ctx.channel.customFields['vivaSourceCode'];
    if (channelOverride)
        return channelOverride;
    if (options.mode === 'isv') {
        if (options.resolveSourceCode)
            return options.resolveSourceCode(ctx);
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
function resolveIsvAmount(options, order, ctx) {
    if (options.mode !== 'isv')
        return 0;
    if (options.resolveIsvAmount)
        return options.resolveIsvAmount(order, ctx);
    return 0;
}
function resolveSuccessUrl(options, ctx) {
    return typeof options.successUrl === 'function' ? options.successUrl(ctx) : options.successUrl;
}
function resolveFailureUrl(options, ctx) {
    return typeof options.failureUrl === 'function' ? options.failureUrl(ctx) : options.failureUrl;
}
/**
 * Resolve the optional Smart Checkout theme color.
 *
 * - ISV mode: optional `resolveCheckoutColor(ctx)` callback.
 * - Merchant mode: optional `config.checkoutColor` string.
 */
function resolveCheckoutColor(options, ctx) {
    if (options.mode === 'isv')
        return options.resolveCheckoutColor?.(ctx);
    return options.checkoutColor;
}
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
function buildOrderIdentity(options, order, ctx) {
    const customerTrnsRaw = options.resolveCustomerTrns
        ? options.resolveCustomerTrns(order, ctx)
        : `Order ${order.code}`;
    const identity = {
        merchantTrns: order.code.slice(0, MERCHANT_TRNS_MAX),
        customerTrns: customerTrnsRaw.slice(0, CUSTOMER_TRNS_MAX),
    };
    const customer = order.customer;
    if (customer) {
        if (customer.emailAddress)
            identity.customerEmail = customer.emailAddress;
        const fullName = `${customer.firstName ?? ''} ${customer.lastName ?? ''}`.trim();
        if (fullName)
            identity.customerFullName = fullName.slice(0, CUSTOMER_FULL_NAME_MAX);
        if (customer.phoneNumber)
            identity.customerPhone = customer.phoneNumber;
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
function buildIdempotencyKey(channelId, orderId, amountMinor, currencyCode) {
    return `viva:${channelId}:${orderId}:${amountMinor}:${currencyCode}`;
}
/**
 * Build the Smart Checkout redirect URL.
 * Demo: https://demo.vivapayments.com/web/checkout?ref={orderCode}
 * Production: https://www.vivapayments.com/web/checkout?ref={orderCode}
 */
function buildCheckoutUrl(environment, orderCode, color) {
    const host = environment === 'production' ? 'www.vivapayments.com' : 'demo.vivapayments.com';
    let url = `https://${host}/web/checkout?ref=${orderCode}`;
    if (color) {
        url += `&color=${color.replace(/^#/, '')}`;
    }
    return url;
}
/** Map a VivaApiError to VivaPluginError.apiError with conditional fields. */
function mapApiError(err) {
    const opts = { message: err.message };
    if (err.vivaCode !== undefined)
        opts.vivaErrorCode = Number(err.vivaCode);
    if (err.message)
        opts.vivaErrorMessage = err.message;
    opts.cause = err;
    throw error_envelope_js_1.VivaPluginError.apiError(opts);
}
/** Returns true when the error indicates a Viva-side 5xx / auth / network failure. */
function isRetryableVivaError(err) {
    if (err instanceof errors_1.VivaAuthError)
        return true;
    if (err instanceof errors_1.VivaApiError && err.httpStatus !== undefined && err.httpStatus >= 500)
        return true;
    return false;
}
// ---------------------------------------------------------------------------
// Test injection — allows unit tests to bypass NestJS DI
// ---------------------------------------------------------------------------
/** @internal Test-only: inject dependencies without NestJS DI. */
function _testInjectDeps(opts) {
    _options = opts.options;
    _oauth2 = opts.oauth2;
    _stateMachine = opts.stateMachine;
    // Always reset overrides; only set if explicitly provided.
    _isvPaymentsOverride = opts.isvPayments;
    _fastRefundOverride = opts.fastRefundClient;
    _resellerLegacyClientOverride = opts.resellerLegacyClient;
}
let _isvPaymentsOverride;
let _fastRefundOverride;
let _resellerLegacyClientOverride;
/**
 * Resolve the reseller-variant legacy client for an ISV refund — the test
 * override if injected, else a freshly built client scoped to the connected
 * merchant. @see buildResellerLegacyClient
 */
function getResellerLegacyClient(options, connectedMerchantId) {
    if (_resellerLegacyClientOverride)
        return _resellerLegacyClientOverride;
    return buildResellerLegacyClient(options.reseller, options.environment, connectedMerchantId);
}
// ---------------------------------------------------------------------------
// PaymentMethodHandler
// ---------------------------------------------------------------------------
exports.vivaPaymentMethodHandler = new core_1.PaymentMethodHandler({
    code: 'viva',
    description: [
        {
            languageCode: core_1.LanguageCode.en,
            value: 'Viva Wallet — Smart Checkout (ISV)',
        },
    ],
    args: {},
    // -------------------------------------------------------------------------
    // init — resolve injected services from NestJS DI
    // -------------------------------------------------------------------------
    init(injector) {
        _options = injector.get(constants_js_1.VIVA_PLUGIN_OPTIONS);
        _oauth2 = injector.get(constants_js_1.VIVA_OAUTH2_STRATEGY_TOKEN);
        _stateMachine = injector.get(state_machine_service_js_1.StateMachineService);
    },
    // -------------------------------------------------------------------------
    // createPayment
    // -------------------------------------------------------------------------
    async createPayment(ctx, order, amount, _args, _metadata) {
        const options = _options;
        const stateMachine = _stateMachine;
        // Step 1: resolve merchantId.
        // - ISV mode: required; resolved per channel.
        // - Merchant mode: undefined — `Payments` ignores opts.merchantId when
        //   constructed with mode='merchant'. We still record `legacyMerchantId`
        //   on the stored row for ops/audit consistency.
        const merchantId = resolveMerchantId(options, ctx);
        if (options.mode === 'isv' && !merchantId) {
            throw error_envelope_js_1.VivaPluginError.channelMisconfigured();
        }
        // Step 2: check vivaPayoutsEnabled gate — ISV-only.
        // In merchant mode there's no onboarding flip; this custom field is
        // meaningless and must not gate the payment.
        if (options.mode === 'isv') {
            const payoutsEnabled = ctx.channel.customFields['vivaPayoutsEnabled'];
            if (payoutsEnabled === false) {
                throw error_envelope_js_1.VivaPluginError.accountNotVerified();
            }
        }
        // Step 3: resolve sourceCode (mode-aware — channel override → fallback).
        const sourceCode = resolveSourceCode(options, ctx);
        // Step 4: resolve isvAmount (always 0 in merchant mode).
        const isvAmount = resolveIsvAmount(options, order, ctx);
        // Step 5: isvAmount guard — only meaningful in ISV mode (merchant mode
        // returns 0 unconditionally, so this guard never fires there).
        if (isvAmount >= amount) {
            throw error_envelope_js_1.VivaPluginError.isvAmountTooHigh(isvAmount, amount);
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
        const storedMerchantId = options.mode === 'isv'
            ? merchantId
            : options.legacyMerchantId;
        const { row, wasInserted } = await stateMachine.upsertPendingTransaction(ctx, {
            channelId: ctx.channelId,
            paymentId: order.id, // proxy until real paymentId available post-return
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
            const meta = row.metadata;
            const existingRedirect = meta['redirectUrl'];
            const expiresAt = typeof meta['expiresAt'] === 'number' ? meta['expiresAt'] : undefined;
            // A row predating this fix has no `expiresAt`; treat unknown expiry as
            // expired and re-mint (correctness over a transient double-submit window).
            const stillLive = expiresAt !== undefined && Date.now() < expiresAt - VIVA_ORDER_EXPIRY_SKEW_MS;
            if (existingRedirect && stillLive) {
                core_1.Logger.info(`[createPayment] Idempotency hit for order ${String(order.id)} — returning cached redirect URL.`, constants_js_1.VIVA_LOG_CONTEXT);
                return {
                    amount,
                    state: 'Created',
                    metadata: {
                        redirectUrl: existingRedirect,
                        vivaOrderCode: row.vivaOrderCode,
                        vivaMerchantId: storedMerchantId,
                    },
                };
            }
            core_1.Logger.info(`[createPayment] Cached Viva order for ${String(order.id)} is expired or unverifiable — minting a fresh order.`, constants_js_1.VIVA_LOG_CONTEXT);
        }
        // Step 10: call Viva createOrder.
        // - ISV mode → POST /checkout/v2/isv/orders?merchantId={uuid} with isvAmount.
        // - Merchant mode → POST /checkout/v2/orders (no merchantId query, no isvAmount in body).
        // The mode branch is entirely inside the `Payments` class — adapter passes
        // `merchantId` either way; merchant-mode Payments silently drops it.
        const isvPayments = getIsvPayments();
        const currencyCode = (0, currency_js_1.alphaToNumeric)(order.currencyCode);
        const callStart = Date.now();
        let orderCode;
        try {
            const createOpts = {
                idempotencyKey,
                ...(merchantId !== undefined ? { merchantId } : {}),
            };
            // Customer identity + merchant reference, drawn from the order already in
            // scope (its `customer` relation is loaded by Vendure). Tags the Viva
            // transaction with the Vendure order code, pre-fills the Smart Checkout
            // page, and lets Viva send its receipt + 3DS email hint. See issue #11.
            const identity = buildOrderIdentity(options, order, ctx);
            const response = await isvPayments.createOrder({
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
            }, createOpts);
            // Viva normally returns an OrderCode; guard the anomalous empty response
            // (e.g. an ISV account configured as its own sub-merchant) so it surfaces
            // as a mappable VIVA_API_ERROR instead of a `.toString()` TypeError → 500.
            if (response.orderCode == null) {
                core_1.Logger.error(`[createPayment] Viva createOrder returned no orderCode for order ${String(order.id)}: ${JSON.stringify(response)}`, constants_js_1.VIVA_LOG_CONTEXT);
                throw error_envelope_js_1.VivaPluginError.apiError({ message: 'Viva createOrder returned no orderCode.' });
            }
            orderCode = response.orderCode;
        }
        catch (err) {
            if (isRetryableVivaError(err)) {
                throw error_envelope_js_1.VivaPluginError.authDown(err instanceof Error ? err.message : String(err), err);
            }
            if (err instanceof errors_1.VivaApiError) {
                mapApiError(err);
            }
            throw err;
        }
        const elapsed = Date.now() - callStart;
        if (elapsed > VIVA_LATENCY_WARN_MS) {
            core_1.Logger.warn(`[createPayment] Viva createOrder took ${elapsed}ms (budget: ${VIVA_LATENCY_WARN_MS}ms) for order ${String(order.id)}.`, constants_js_1.VIVA_LOG_CONTEXT);
        }
        // Step 12: construct redirect URL
        const orderCodeStr = orderCode.toString();
        const redirectUrl = buildCheckoutUrl(options.environment, orderCode, color);
        // Step 13: substitute {orderCode} in success/failure URLs and store on row metadata
        const successUrl = (0, url_template_js_1.substitute)(successUrlTemplate, { orderCode: orderCodeStr });
        const failureUrl = (0, url_template_js_1.substitute)(failureUrlTemplate, { orderCode: orderCodeStr });
        // Stamp the order's expiry so a later idempotency hit can tell a live
        // cached redirect from a dead one. Approximated from the Viva default
        // paymentTimeout (the plugin does not override it); the skew margin on
        // reuse absorbs minting/clock drift.
        const expiresAt = Date.now() + VIVA_ORDER_TTL_SECONDS * 1000;
        const rowMetadata = {
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
            state: 'Created',
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
        const stateMachine = _stateMachine;
        // Idempotent: already settled → no-op
        if (payment.state === 'Settled') {
            return { success: true };
        }
        const row = await stateMachine.getVivaTransaction(ctx, ctx.channelId, payment.id);
        if (row) {
            const existingMeta = row.metadata;
            await stateMachine.setStatus(ctx, row.id, 'captured', {
                ...existingMeta,
                settledAt: new Date().toISOString(),
            });
        }
        return {
            success: true,
            metadata: { settledAt: new Date().toISOString() },
        };
    },
    // -------------------------------------------------------------------------
    // cancelPayment — invoked by Shop API mutation on ?paymentCancelled=1 (V8)
    // -------------------------------------------------------------------------
    async cancelPayment(ctx, _order, payment, _args) {
        const options = _options;
        const stateMachine = _stateMachine;
        // Step 1: load transaction row
        const row = await stateMachine.getVivaTransaction(ctx, ctx.channelId, payment.id);
        // Step 2: missing row or no orderCode
        if (!row || !row.vivaOrderCode) {
            throw error_envelope_js_1.VivaPluginError.paymentNotCancellable('No Viva order code found — payment may not have been initiated.');
        }
        // Step 3: already terminal
        if (TERMINAL_STATUSES.has(row.status)) {
            throw error_envelope_js_1.VivaPluginError.paymentNotCancellable(`Payment is already in terminal state: ${row.status}.`);
        }
        // Step 4: resolve merchantId (ISV mode only — fallback to metadata-stored
        // value for robustness when the channel custom field was unset after the
        // row was created). Merchant mode passes undefined; `Payments` silently
        // drops it from the DELETE URL.
        let merchantId;
        if (options.mode === 'isv') {
            merchantId =
                (resolveMerchantId(options, ctx) ??
                    row.metadata['vivaMerchantId']);
            if (!merchantId) {
                throw error_envelope_js_1.VivaPluginError.channelMisconfigured();
            }
        }
        // Step 5: call Viva cancelOrder.
        // - ISV mode: DELETE /checkout/v2/orders/{oc}?merchantId={uuid}.
        // - Merchant mode: DELETE /checkout/v2/orders/{oc}.
        const isvPayments = getIsvPayments();
        const cancelOpts = merchantId !== undefined ? { merchantId } : {};
        try {
            await isvPayments.cancelOrder(BigInt(row.vivaOrderCode), cancelOpts);
        }
        catch (err) {
            // Transient Viva failure (5xx / auth / network): surface as retryable so
            // the storefront can re-attempt the cancel. The local Payment stays
            // `Created`, but that is recoverable — a later cancel succeeds — not a
            // permanent brick.
            if (isRetryableVivaError(err)) {
                throw error_envelope_js_1.VivaPluginError.authDown(err instanceof Error ? err.message : String(err), err);
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
            const detail = err instanceof errors_1.VivaApiError
                ? `HTTP ${err.httpStatus ?? '?'}${err.vivaCode !== undefined ? ` viva=${String(err.vivaCode)}` : ''}: ${err.message}`
                : err instanceof Error
                    ? err.message
                    : String(err);
            core_1.Logger.warn(`[cancelPayment] Viva cancelOrder for order ${row.vivaOrderCode} failed non-retryably (${detail}) — ` +
                `cancelling the local Payment anyway so the order can be retried (#16).`, constants_js_1.VIVA_LOG_CONTEXT);
        }
        // Step 6: update row status
        const existingMeta = row.metadata;
        await stateMachine.setStatus(ctx, row.id, 'cancelled', {
            ...existingMeta,
            cancelledAt: new Date().toISOString(),
        });
        return { success: true };
    },
    // -------------------------------------------------------------------------
    // createRefund — invoked by Vendure admin refund flow
    // -------------------------------------------------------------------------
    async createRefund(ctx, input, amount, _order, payment, _args) {
        const options = _options;
        const stateMachine = _stateMachine;
        // Step 1: load transaction row
        const row = await stateMachine.getVivaTransaction(ctx, ctx.channelId, payment.id);
        if (!row) {
            throw error_envelope_js_1.VivaPluginError.refundRejected('VivaTransaction row not found for this payment.');
        }
        // Step 2: status must be captured
        if (row.status !== 'captured') {
            throw error_envelope_js_1.VivaPluginError.refundRejected(`Payment not yet captured (status: ${row.status}). Refund requires captured status.`);
        }
        // Step 3: need vivaTransactionId (populated by webhook worker V7)
        if (!row.vivaTransactionId) {
            throw error_envelope_js_1.VivaPluginError.refundRejected('Viva transaction ID not yet known — webhook may be pending.');
        }
        // Step 4: determine amountMinor (omit for full refund per SDK contract)
        const isFullRefund = input.amount === payment.amount;
        const amountMinor = isFullRefund ? undefined : BigInt(amount);
        // Step 5: resolve merchantId for Standard refund leg.
        // - ISV mode: required (resolved from channel + row metadata fallback).
        // - Merchant mode: pass the configured legacyMerchantId. The Payments
        //   method requires a value at the type level but does NOT encode it in
        //   the URL — the legacy refund endpoint authenticates via Basic auth on
        //   the host, not via a path/query param.
        let merchantId;
        if (options.mode === 'isv') {
            const resolved = (resolveMerchantId(options, ctx) ??
                row.metadata['vivaMerchantId']);
            if (!resolved) {
                throw error_envelope_js_1.VivaPluginError.channelMisconfigured();
            }
            merchantId = resolved;
        }
        else {
            merchantId = options.legacyMerchantId;
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
                throw error_envelope_js_1.VivaPluginError.refundRejected('ISV refund requires reseller credentials (options.reseller = { resellerId, ' +
                    'merchantId, resellerApiKey }). These are the Viva-issued Reseller ID/API key ' +
                    '(demo and production pairs differ; production is obtained from Viva), distinct ' +
                    'from the dashboard ISV credentials.');
            }
        }
        else if (!options.legacyMerchantId || !options.legacyApiKey) {
            throw error_envelope_js_1.VivaPluginError.refundRejected('Merchant-mode refund requires legacyMerchantId and legacyApiKey (Merchant Basic auth). ' +
                'Refund path: DELETE /api/transactions/{id} on the legacy host.');
        }
        const isvPayments = getIsvPayments();
        // Step 7: branch refund path on mode.
        //   ISV mode      → Standard refund only (Payments.refundPayment).
        //   Merchant mode → resolveRefundStrategy + FastRefundClient, with
        //                   auto-fallback to Standard on HTTP 403 (auto only).
        let refundResponse;
        if (options.mode === 'isv') {
            // Build the reseller-variant client scoped to THIS connected merchant.
            // `options.reseller` presence is guaranteed by the Step 6 pre-check.
            const resellerLegacyClient = getResellerLegacyClient(options, merchantId);
            refundResponse = await callStandardRefund(isvPayments, row.vivaTransactionId, merchantId, amountMinor, refundIdempotencyKey, resellerLegacyClient);
        }
        else {
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
        const newStatus = isFullRefund ? 'refunded' : 'partially_refunded';
        const existingMeta = row.metadata;
        const refundedSoFar = existingMeta['refundedAmountMinor'] ?? 0;
        await stateMachine.setStatus(ctx, row.id, newStatus, {
            ...existingMeta,
            refundedAmountMinor: refundedSoFar + amount,
            lastRefundTransactionId: refundResponse.transactionId,
            lastRefundAt: new Date().toISOString(),
        });
        // Step 9: return per Vendure refund contract
        return {
            state: 'Settled',
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
async function callStandardRefund(isvPayments, vivaTransactionId, merchantId, amountMinor, refundIdempotencyKey, legacyClientOverride) {
    try {
        const opts = {
            merchantId,
            idempotencyKey: refundIdempotencyKey,
        };
        if (amountMinor !== undefined)
            opts.amountMinor = amountMinor;
        // ISV mode injects a reseller-variant client scoped to the connected
        // merchant; merchant mode leaves this undefined to use the Merchant Basic
        // client wired at construction time.
        if (legacyClientOverride !== undefined)
            opts.legacyClient = legacyClientOverride;
        const refundResponse = await isvPayments.refundPayment(vivaTransactionId, opts);
        return { transactionId: refundResponse.transactionId };
    }
    catch (err) {
        if (isRetryableVivaError(err)) {
            throw error_envelope_js_1.VivaPluginError.authDown(err instanceof Error ? err.message : String(err), err);
        }
        if (err instanceof errors_1.VivaApiError) {
            throw error_envelope_js_1.VivaPluginError.refundRejected(err.message, err);
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
async function refundMerchantMode(params) {
    const { options, isvPayments, fastRefundClient, vivaTransactionId, amountMinor, fullAmountMinor, isFullRefund, refundIdempotencyKey, rowMerchantId, } = params;
    const configuredStrategy = options.refundStrategy ?? 'auto';
    // Step 1: look up cardType. Failure → log + proceed; strategy falls through
    // to the `auto-no-card-info` branch (which routes to Standard).
    let cardType;
    try {
        const tx = await isvPayments.retrieveTransaction(vivaTransactionId);
        cardType = tx.cardType;
    }
    catch (err) {
        core_1.Logger.warn(`[createRefund] retrieveTransaction failed for '${vivaTransactionId}': ` +
            `${err instanceof Error ? err.message : String(err)}. ` +
            `Refund strategy will route via 'auto-no-card-info' (Standard).`, constants_js_1.VIVA_LOG_CONTEXT);
    }
    // Step 2: resolve strategy.
    const decision = (0, refunds_1.resolveRefundStrategy)(configuredStrategy, {
        ...(cardType !== undefined ? { cardType } : {}),
        isCardNotPresent: true, // Smart Checkout — always CNP
    });
    if (decision.kind === 'fast') {
        // Fast Refund requires an explicit amount (no full-refund-by-omission).
        const fastAmount = isFullRefund ? fullAmountMinor : amountMinor;
        try {
            const result = await fastRefundClient.refund({
                transactionId: vivaTransactionId,
                amount: fastAmount,
                sourceCode: options.sourceCode ?? DEFAULT_SOURCE_CODE,
                merchantTrns: refundIdempotencyKey,
                idempotencyKey: refundIdempotencyKey,
            });
            return { transactionId: result.transactionId };
        }
        catch (err) {
            const is403 = err instanceof errors_1.VivaApiError && err.httpStatus === 403;
            if (is403 && configuredStrategy === 'fast') {
                // Explicit `fast` opt-in does not fall back — surface as a distinct
                // code so callers can prompt operators to switch to 'auto' instead of
                // treating it as a generic refund rejection.
                throw error_envelope_js_1.VivaPluginError.fastRefundIneligible(undefined, err);
            }
            if (!is403) {
                if (isRetryableVivaError(err)) {
                    throw error_envelope_js_1.VivaPluginError.authDown(err instanceof Error ? err.message : String(err), err);
                }
                if (err instanceof errors_1.VivaApiError) {
                    throw error_envelope_js_1.VivaPluginError.refundRejected(err.message, err);
                }
                throw err;
            }
            // is403 + auto → fall through to Standard refund.
            core_1.Logger.info(`[createRefund] Fast Refund 403 with strategy='auto' — falling back to Standard refund for ${vivaTransactionId}.`, constants_js_1.VIVA_LOG_CONTEXT);
        }
    }
    // Standard refund — Payments.refundPayment routes via legacy/Basic auth.
    return callStandardRefund(isvPayments, vivaTransactionId, rowMerchantId, amountMinor, refundIdempotencyKey);
}
//# sourceMappingURL=payment-method-handler.js.map