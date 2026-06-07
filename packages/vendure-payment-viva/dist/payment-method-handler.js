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
/** Terminal statuses — cannot cancel a payment in these states. */
const TERMINAL_STATUSES = new Set(['captured', 'refunded', 'partially_refunded', 'failed', 'cancelled']);
/**
 * Default Smart Checkout source code used when neither the channel custom
 * field `vivaSourceCode` nor `config.sourceCode` (merchant mode) is set.
 *
 * @see references/viva-docs/md/payment-source-for-isv.txt:101
 */
const DEFAULT_SOURCE_CODE = 'Default';
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
    // Legacy Basic-auth client used by `Payments.refundPayment` (Standard refund).
    // Probe-verified 2026-04-25 (F1): POST /checkout/v2/transactions/{id} → 405.
    // Refund must use the legacy host with Basic auth (legacyMerchantId:legacyApiKey).
    // @see references/viva-docs/md/tut-create-recurring-payment.txt:288
    const legacyClient = buildLegacyClient(options);
    return new payments_1.Payments({
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
function buildLegacyClient(options) {
    return new legacy_1.BasicAuthClient({
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
}
let _isvPaymentsOverride;
let _fastRefundOverride;
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
        // Idempotency: existing row with vivaOrderCode → return cached redirect URL
        if (!wasInserted && row.vivaOrderCode) {
            const existingRedirect = row.metadata['redirectUrl'];
            if (existingRedirect) {
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
            const response = await isvPayments.createOrder({
                amount: BigInt(amount),
                currencyCode,
                sourceCode,
                // TODO(impl): confirm Viva ISV fee field name for isvAmount.
                // The ISV platform fee (isvAmount) field name is unconfirmed from local docs.
                // Current assumption: Viva does not accept it in the createOrder body;
                // it is configured per-source in Viva Self Care instead.
                // @see references/viva-docs/md/isv-partner-program.txt:104
            }, createOpts);
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
        const rowMetadata = {
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
            if (isRetryableVivaError(err)) {
                throw error_envelope_js_1.VivaPluginError.authDown(err instanceof Error ? err.message : String(err), err);
            }
            if (err instanceof errors_1.VivaApiError) {
                mapApiError(err);
            }
            throw err;
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
        // Step 6: pre-check legacy creds. Refunds in both modes ultimately depend
        // on the legacy host (Standard refund directly; Fast Refund falls back to
        // Standard on 403 when strategy==='auto'). Without these creds the refund
        // cannot proceed.
        // @see references/viva-docs/md/tut-create-recurring-payment.txt:288
        if (!options.legacyMerchantId || !options.legacyApiKey) {
            throw error_envelope_js_1.VivaPluginError.refundRejected('Viva refund requires legacyMerchantId and legacyApiKey in plugin options. ' +
                'Probe-verified 2026-04-25: POST /checkout/v2/transactions/{id} returns 405. ' +
                'Only the legacy host with Basic auth works for Standard refund.');
        }
        const isvPayments = getIsvPayments();
        // Step 7: branch refund path on mode.
        //   ISV mode      → Standard refund only (Payments.refundPayment).
        //   Merchant mode → resolveRefundStrategy + FastRefundClient, with
        //                   auto-fallback to Standard on HTTP 403 (auto only).
        let refundResponse;
        if (options.mode === 'isv') {
            refundResponse = await callStandardRefund(isvPayments, row.vivaTransactionId, merchantId, amountMinor, refundIdempotencyKey);
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
async function callStandardRefund(isvPayments, vivaTransactionId, merchantId, amountMinor, refundIdempotencyKey) {
    try {
        const opts = {
            merchantId,
            idempotencyKey: refundIdempotencyKey,
        };
        if (amountMinor !== undefined)
            opts.amountMinor = amountMinor;
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