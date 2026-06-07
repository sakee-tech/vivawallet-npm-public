"use strict";
/**
 * Payments — Viva Payment API methods (mode-aware).
 *
 * The class is parameterised by `mode: 'merchant' | 'isv'`. URL paths and
 * query-string contracts switch per mode:
 *
 *   createOrder
 *     merchant → POST /checkout/v2/orders                       (OAuth2)
 *     isv      → POST /checkout/v2/isv/orders?merchantId={uuid} (OAuth2)
 *   retrieveTransaction
 *     merchant → GET /checkout/v2/transactions/{transactionId}                (OAuth2)
 *     isv      → GET /checkout/v2/isv/transactions/{transactionId}?merchantId={uuid} (OAuth2)
 *   cancelOrder
 *     merchant → DELETE /checkout/v2/orders/{orderCode}                       (OAuth2)
 *     isv      → DELETE /checkout/v2/orders/{orderCode}?merchantId={uuid}     (OAuth2)
 *   refundPayment
 *     both     → POST /api/transactions/{transactionId}                       (Legacy/Basic)
 *
 * In merchant mode `opts.merchantId` (if passed) is silently ignored — never
 * added to the query string. In ISV mode `merchantId` is required and a
 * VivaValidationError is thrown if absent.
 *
 * `CreateOrderRequest.isvAmount` is stripped from the wire body when
 * `mode === 'merchant'` — only forwarded on the ISV `/isv/orders` path.
 *
 * All methods validate inputs locally before making HTTP calls.
 * Amounts are in integer minor units (bigint) per plan P15.
 *
 * Idempotency: createOrder and refundPayment are non-idempotent (idempotent: false).
 * retrieveTransaction and cancelOrder are idempotent.
 *
 * --- Refund path (F1 — probe-verified 2026-04-25) ---
 * Viva returns 405 on `POST /checkout/v2/transactions/{id}` (v2/OAuth2 path).
 * The ONLY working refund path is `POST /api/transactions/{transactionId}` on the
 * LEGACY HOST (`demo.vivapayments.com` / `www.vivapayments.com`) with Basic auth
 * (MerchantId + ApiKey). The 401-fallback design is NOT applicable here — Viva
 * returns 405 (not 401) on the v2 path, so no fallback would ever trigger.
 * refundPayment now calls `legacyClient` DIRECTLY without any v2 attempt.
 *
 * @see references/viva-docs/md/tut-create-recurring-payment.txt:288 (legacy refund endpoint)
 *
 * --- retrieveTransaction / cancelOrder fallback (D15 — kept defensive) ---
 *   The optional `secondaryClient` is a fallback for retrieveTransaction and
 *   cancelOrder. When the primary OAuth2 client returns 401 (after force-refresh),
 *   the call retries once with the secondary client. A 401 from secondary surfaces
 *   as VivaAuthError — no further retry.
 *   Note: cancelOrder is unverified against live sandbox as of 2026-04-25 probe;
 *   kept on OAuth2 + 401-fallback path defensively.
 *
 * --- Idempotency-Key header (F2 — probe-verified 2026-04-25) ---
 *   The `Idempotency-Key` header is sent on createOrder but Viva does NOT appear
 *   to deduplicate server-side (same key returned two different orderCodes in probe).
 *   Local dedup via `viva_transaction` row is the authoritative dedup mechanism.
 *   Header is retained for forward-compat (zero cost, may be honoured in future).
 *
 * @see references/viva-docs/md/payment-isv-api.txt:1
 * @see references/viva-docs/md/webhooks-for-payments.txt:248 (retrieve before update)
 * @see references/viva-docs/md/isv-partner-program.txt:104 (ISV overview)
 * @see references/viva-docs/md/isv-credentials.txt:107 (reseller credentials)
 * @see docs/plans/vendure-plugin-v0.md §D15 (reseller fallback scope)
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.Payments = void 0;
const index_js_1 = require("../errors/index.js");
const card_types_js_1 = require("../types/card-types.js");
// ---------------------------------------------------------------------------
// Validation helpers
// ---------------------------------------------------------------------------
/**
 * Validates an ISO 4217 numeric currency code (3-digit numeric string).
 *
 * Per plan P15: currencyCode must be a valid 3-digit numeric string.
 * Examples: '978' (EUR), '826' (GBP), '840' (USD).
 *
 * @see references/viva-docs/md/webhooks-for-payments.txt:487
 */
function isValidCurrencyCode(code) {
    return /^\d{3}$/.test(code);
}
/**
 * Build the path + query for `POST /checkout/v2/(isv/)orders`.
 *
 * In ISV mode `merchantId` is REQUIRED — throws VivaValidationError if absent.
 * In merchant mode `merchantId` is ignored entirely.
 */
function buildOrderCreateUrl(mode, merchantId) {
    switch (mode) {
        case 'merchant':
            return { path: '/checkout/v2/orders', query: {} };
        case 'isv':
            if (!merchantId) {
                throw new index_js_1.VivaValidationError({
                    message: "createOrder: merchantId is required when mode='isv'",
                });
            }
            return { path: '/checkout/v2/isv/orders', query: { merchantId } };
    }
}
/**
 * Build the path + query for `GET /checkout/v2/(isv/)transactions/{id}`.
 *
 * In ISV mode `merchantId` is REQUIRED — throws VivaValidationError if absent.
 * In merchant mode `merchantId` is ignored entirely.
 */
function buildTransactionRetrieveUrl(mode, transactionId, merchantId) {
    switch (mode) {
        case 'merchant':
            return { path: `/checkout/v2/transactions/${transactionId}`, query: {} };
        case 'isv':
            if (!merchantId) {
                throw new index_js_1.VivaValidationError({
                    message: "retrieveTransaction: merchantId is required when mode='isv'",
                });
            }
            return {
                path: `/checkout/v2/isv/transactions/${transactionId}`,
                query: { merchantId },
            };
    }
}
/**
 * Build the path + query for `DELETE /checkout/v2/orders/{orderCode}`.
 *
 * Both modes share the same path template; only ISV mode appends the
 * `merchantId` query parameter (and requires it).
 */
function buildOrderCancelUrl(mode, orderCode, merchantId) {
    const path = `/checkout/v2/orders/${orderCode}`;
    switch (mode) {
        case 'merchant':
            return { path, query: {} };
        case 'isv':
            if (!merchantId) {
                throw new index_js_1.VivaValidationError({
                    message: "cancelOrder: merchantId is required when mode='isv'",
                });
            }
            return { path, query: { merchantId } };
    }
}
// ---------------------------------------------------------------------------
// Payments
// ---------------------------------------------------------------------------
/**
 * Viva Payment API client (mode-aware).
 *
 * Constructed with a {@link PaymentsConfig}. The `mode` field determines URL
 * paths and query-string contract per slice 2 of the multi-mode refactor.
 *
 * - `mode`: `'merchant'` or `'isv'`. Required.
 * - `client`: primary OAuth2 client for createOrder, retrieveTransaction, cancelOrder.
 * - `secondaryClient`: optional 401-fallback for retrieveTransaction and cancelOrder.
 *   When undefined, 401 errors propagate normally.
 * - `legacyClient`: REQUIRED for refundPayment. Calls `POST /api/transactions/{id}`
 *   on the legacy host with Basic auth (MerchantId + ApiKey). If absent, refundPayment
 *   throws `VIVA_REFUND_REJECTED` with a config-missing message.
 *
 * Probe-verified 2026-04-25: refund MUST go through legacy client — v2/OAuth2 path
 * returns 405. cancelOrder is unverified but kept on v2/OAuth2 + 401-fallback defensively.
 *
 * @see docs/plans/multi-mode-v0.md §8.1
 * @see references/viva-docs/md/tut-create-recurring-payment.txt:288 (legacy refund path)
 * @see references/viva-docs/md/payment-isv-api.txt:1
 * @see references/viva-docs/md/isv-partner-program.txt:61 (P1: merchant scoping)
 * @see references/viva-docs/md/isv-credentials.txt:107 (reseller credentials)
 * @see docs/plans/vendure-plugin-v0.md §D15 (reseller fallback)
 */
class Payments {
    mode;
    client;
    secondaryClient;
    legacyClient;
    constructor(config) {
        this.mode = config.mode;
        this.client = config.client;
        this.secondaryClient = config.secondaryClient;
        this.legacyClient = config.legacyClient;
    }
    /**
     * Create a payment order for a specific ISV merchant.
     *
     * Sends a POST /checkout/v2/orders?merchantId={merchantId} request.
     * The `Idempotency-Key` header is sent on every call but Viva does NOT appear
     * to deduplicate server-side as of 2026-04-25 (probe: same key → two different
     * orderCodes). Local dedup via `viva_transaction` row is the authoritative
     * dedup mechanism. Header retained for forward-compat only.
     *
     * Input validation (throws VivaValidationError before HTTP call):
     *   - amountMinor must be > 0 (per plan P15)
     *   - currencyCode must be a valid 3-digit numeric string (per plan P15)
     *
     * Non-idempotent: does not retry on 4xx/5xx (only connection-level errors).
     *
     * @see references/viva-docs/md/payment-isv-api.txt:1
     * @see references/viva-docs/md/isv-partner-program.txt:61 (P14 idempotency)
     * @see references/viva-docs/md/isv-partner-program.txt:83 (P15 amounts)
     */
    async createOrder(req, opts) {
        // Local validation per P14 and P15
        if (req.amount <= 0n) {
            throw new index_js_1.VivaValidationError({
                message: `createOrder: amountMinor must be > 0, got ${req.amount}`,
            });
        }
        if (!isValidCurrencyCode(req.currencyCode)) {
            throw new index_js_1.VivaValidationError({
                message: `createOrder: currencyCode must be a 3-digit numeric string (ISO 4217), got "${req.currencyCode}"`,
            });
        }
        // Resolve URL per mode. Throws VivaValidationError in ISV mode if
        // merchantId is missing. In merchant mode `opts.merchantId` is silently
        // ignored — back-compat for adapters that still pass it.
        const { path, query } = buildOrderCreateUrl(this.mode, opts.merchantId);
        // Build wire body: convert bigint amount to number for JSON.
        // Amount in minor units is always within safe integer range for real payments.
        const wireBody = {
            amount: req.amount, // bigintSafeStringify in client handles this
            currencyCode: Number(req.currencyCode), // Viva expects numeric currency code as number
        };
        if (req.merchantTrns !== undefined)
            wireBody['merchantTrns'] = req.merchantTrns;
        if (req.customerTrns !== undefined)
            wireBody['customerTrns'] = req.customerTrns;
        if (req.customerEmail !== undefined)
            wireBody['email'] = req.customerEmail;
        if (req.customerPhone !== undefined)
            wireBody['phone'] = req.customerPhone;
        if (req.customerFullName !== undefined)
            wireBody['fullName'] = req.customerFullName;
        if (req.successUrl !== undefined)
            wireBody['successUrl'] = req.successUrl;
        if (req.failureUrl !== undefined)
            wireBody['failureUrl'] = req.failureUrl;
        if (req.tags !== undefined)
            wireBody['tags'] = req.tags;
        if (req.sourceCode !== undefined)
            wireBody['sourceCode'] = req.sourceCode;
        if (req.paymentTimeoutSeconds !== undefined)
            wireBody['paymentTimeout'] = req.paymentTimeoutSeconds;
        if (req.preselectedPaymentMethod !== undefined)
            wireBody['preselectedPaymentMethod'] = req.preselectedPaymentMethod;
        // ISV-only: `isvAmount` only emitted in ISV mode. Strip in merchant mode
        // even if caller passed it (forward-compat shim for shared adapter code).
        if (this.mode === 'isv' && req.isvAmount !== undefined) {
            wireBody['isvAmount'] = req.isvAmount;
        }
        const raw = await this.client.request({
            method: 'POST',
            path,
            query,
            body: wireBody,
            idempotencyKey: opts.idempotencyKey,
            idempotent: false, // per plan Auth Flow line 319
            endpoint: `POST ${path}`,
        });
        return { orderCode: raw.OrderCode };
    }
    /**
     * Retrieve transaction details for a specific ISV merchant transaction.
     *
     * Per Viva docs, this SHOULD be called before updating any local transaction
     * status on receipt of a webhook. Validates orderCode and statusId from Viva.
     *
     * Idempotent: safe to retry on 429 and 5xx.
     *
     * Path + auth verified 2026-04-25 (F3):
     *   `GET /checkout/v2/transactions/{transactionId}` with OAuth2 Bearer → correct.
     *   404 error envelope shape: `{"status": 404, "message": null, "eventId": "0"}`.
     *   Note: `message` can be null — handle defensively.
     *
     * 401 → reseller fallback (D15) — kept DEFENSIVE:
     *   If the primary OAuth2 client receives a 401 and secondaryClient is configured,
     *   the request is retried once with the secondary (Reseller basic-auth) client.
     *   A 401 from the secondary surfaces immediately as VivaAuthError — no further retry.
     *   The primary path is verified working; fallback is defensive for edge-case tenants.
     *
     * @see references/viva-docs/md/webhooks-for-payments.txt:248 (retrieve before update)
     * @see references/viva-docs/md/payment-isv-api.txt:1
     * @see references/viva-docs/md/isv-credentials.txt:107 (reseller basic-auth)
     * @see docs/plans/vendure-plugin-v0.md §D15 (reseller fallback scope)
     */
    async retrieveTransaction(transactionId, opts = {}) {
        // Resolve URL per mode. In merchant mode `opts.merchantId` is silently
        // ignored. In ISV mode it is required.
        const { path, query } = buildTransactionRetrieveUrl(this.mode, transactionId, opts.merchantId);
        const endpointTemplate = this.mode === 'isv'
            ? 'GET /checkout/v2/isv/transactions/{transactionId}'
            : 'GET /checkout/v2/transactions/{transactionId}';
        const requestOpts = {
            method: 'GET',
            path,
            query,
            idempotent: true,
            endpoint: endpointTemplate,
        };
        // Viva API returns PascalCase field names (e.g. OrderCode, StatusId).
        // We normalize to camelCase matching RetrieveTransactionResponse.
        // The bigint-safe parser in IsvHttpClient already converts OrderCode to bigint.
        let raw;
        try {
            raw = await this.client.request(requestOpts);
        }
        catch (err) {
            // 401 → reseller fallback (D15). Only attempt if secondaryClient is present.
            // A 401 from the secondary surfaces immediately — no further retry.
            // @see docs/plans/vendure-plugin-v0.md §D15
            // @see references/viva-docs/md/isv-credentials.txt:107
            if (err instanceof index_js_1.VivaAuthError && err.httpStatus === 401 && this.secondaryClient) {
                raw = await this.secondaryClient.request(requestOpts);
            }
            else {
                throw err;
            }
        }
        // Normalize: accept both PascalCase (wire) and camelCase (normalized) field names.
        // @see references/viva-docs/md/account-api.txt:1584 (OrderCode: long)
        const orderCode = (raw['orderCode'] ?? raw['OrderCode']);
        const cardNumber = raw['cardNumber'] ?? raw['CardNumber'];
        const cardTypeId = raw['cardTypeId'] ?? raw['CardTypeId'];
        const email = raw['email'] ?? raw['Email'];
        const fullName = raw['fullName'] ?? raw['FullName'];
        const merchantTrns = raw['merchantTrns'] ?? raw['MerchantTrns'];
        const customerTrns = raw['customerTrns'] ?? raw['CustomerTrns'];
        const connectedAccountId = raw['connectedAccountId'] ?? raw['ConnectedAccountId'];
        // Derive cardType (string scheme name) from Viva's numeric cardTypeId.
        // Pure mapping via resolveCardType — undefined when id is absent, a
        // sentinel (Invalid/Unknown), or otherwise unmapped.
        // @see ../types/card-types.ts
        // @see ../refunds/strategy.ts (consumer)
        const cardType = typeof cardTypeId === 'number' ? (0, card_types_js_1.resolveCardType)(cardTypeId) : undefined;
        // Build with conditional optional fields to satisfy exactOptionalPropertyTypes.
        // (Cannot assign to readonly Partial<> properties so we use spread.)
        return {
            transactionId: (raw['transactionId'] ?? raw['TransactionId']),
            orderCode,
            statusId: (raw['statusId'] ?? raw['StatusId']),
            amount: BigInt((raw['amount'] ?? raw['Amount']) ?? 0),
            currencyCode: (raw['currencyCode'] ?? raw['CurrencyCode']),
            merchantId: (raw['merchantId'] ?? raw['MerchantId']),
            parentId: (raw['parentId'] ?? raw['ParentId']) ?? null,
            insDate: (raw['insDate'] ?? raw['InsDate'] ?? ''),
            transactionTypeId: (raw['transactionTypeId'] ?? raw['TransactionTypeId']) ?? 0,
            ...(typeof cardNumber === 'string' ? { cardNumber } : {}),
            ...(typeof cardTypeId === 'number' ? { cardTypeId } : {}),
            ...(cardType !== undefined ? { cardType } : {}),
            ...(typeof email === 'string' ? { email } : {}),
            ...(typeof fullName === 'string' ? { fullName } : {}),
            ...(typeof merchantTrns === 'string' ? { merchantTrns } : {}),
            ...(typeof customerTrns === 'string' ? { customerTrns } : {}),
            ...(typeof connectedAccountId === 'string' ? { connectedAccountId } : {}),
        };
    }
    /**
     * Issue a full or partial refund for a captured transaction.
     *
     * IMPORTANT — probe-verified 2026-04-25 (F1):
     *   Viva returns 405 Method Not Allowed on `POST /checkout/v2/transactions/{id}`
     *   (the v2/OAuth2 path). The ONLY working refund path is:
     *     `POST /api/transactions/{transactionId}` on the LEGACY HOST
     *     (`demo.vivapayments.com` / `www.vivapayments.com`) with Basic auth
     *     (MerchantId:ApiKey) and form-urlencoded body.
     *
     *   This method calls `legacyClient` DIRECTLY. The 401-fallback (D15) does NOT
     *   apply here — Viva returns 405 (not 401) on the v2 path, so no fallback
     *   could ever trigger.
     *
     *   If `legacyClient` is not configured (absent from constructor), this method
     *   throws VivaValidationError with code VIVA_REFUND_REJECTED indicating that
     *   the basic-auth credentials are required and missing.
     *
     * Per plan P18:
     *   - Full refund: omit amountMinor (no Amount in form body per Viva convention).
     *   - Partial refund: provide amountMinor > 0 (Amount sent in form body).
     *   - ISV fee reverses automatically on refund (per isv-partner-program.txt:296).
     *   - Failed refund (4xx) surfaces as VivaApiError; payment NOT marked refunded.
     *
     * Non-idempotent: does not retry on 4xx/5xx.
     *
     * Viva response fields (PascalCase, mapped to camelCase):
     *   StatusId → statusId, Amount → amount, TransactionId → transactionId.
     *
     * @see references/viva-docs/md/tut-create-recurring-payment.txt:288 (legacy path + basic auth)
     * @see references/viva-docs/md/isv-partner-program.txt:296 (ISV fee reversal on refund)
     * @see references/viva-docs/md/merchant-id-and-api-key.txt:1 (basic auth credentials)
     */
    async refundPayment(transactionId, opts) {
        // Local validation per P18
        if (opts.amountMinor !== undefined && opts.amountMinor <= 0n) {
            throw new index_js_1.VivaValidationError({
                message: `refundPayment: amountMinor must be > 0 when specified, got ${opts.amountMinor}`,
            });
        }
        // legacyClient REQUIRED for refund (F1 — probe-verified 2026-04-25).
        if (!this.legacyClient) {
            throw new index_js_1.VivaValidationError({
                message: 'refundPayment requires a legacyClient (Basic auth with MerchantId + ApiKey). ' +
                    'Configure VIVA_MERCHANT_ID and VIVA_API_KEY in plugin options. ' +
                    'Viva returns 405 on the v2/OAuth2 refund path (probe-verified 2026-04-25).',
            });
        }
        // Build form-urlencoded body.
        // - Amount: send only for partial refund; omit for full refund per Viva convention.
        // - SourceCode: defaults to 'Default'.
        // @see references/viva-docs/md/tut-create-recurring-payment.txt:288
        const formBody = {
            SourceCode: opts.sourceCode ?? 'Default',
        };
        if (opts.amountMinor !== undefined) {
            // Viva legacy endpoint expects amount in minor units as integer.
            formBody['Amount'] = opts.amountMinor;
        }
        const result = await this.legacyClient.request({
            method: 'POST',
            path: `/api/transactions/${transactionId}`,
            formBody,
            idempotent: false, // non-idempotent POST — no 4xx/5xx retry
            endpoint: 'POST /api/transactions/{transactionId}',
        });
        const raw = result.data;
        // Map PascalCase → camelCase and return typed RefundResponse.
        return {
            transactionId: (raw.TransactionId ?? transactionId),
            ...(raw.StatusId !== undefined ? { statusId: raw.StatusId } : {}),
            ...(raw.Amount !== undefined ? { amount: BigInt(raw.Amount) } : {}),
        };
    }
    /**
     * Cancel an order that has not yet been paid.
     *
     * Idempotent per Viva docs: calling cancel on an already-cancelled or
     * captured order returns the existing Viva response without error.
     *
     * Per plan P18: cancellation triggers webhook 4865 (Order Updated).
     *
     * Path: `DELETE /checkout/v2/orders/{orderCode}?merchantId={merchantId}` (OAuth2).
     *
     * UNVERIFIED against live sandbox as of 2026-04-25 probe. Only
     * cancel-transaction (refund/reverse) was tested; cancel-order was not.
     * Kept on v2/OAuth2 + 401-fallback path defensively.
     *
     * 401 → reseller fallback (D15) — kept DEFENSIVE:
     *   If the primary OAuth2 client receives a 401 and secondaryClient is configured,
     *   the request is retried once with the secondary (Reseller basic-auth) client.
     *   A 401 from the secondary surfaces immediately as VivaAuthError — no further retry.
     *
     * Note: if cancelOrder already succeeded on Viva's side before any 401 is
     * observed, a 4xx from Viva on a subsequent attempt signals the order is
     * already cancelled (idempotent). The fallback does NOT apply to non-401
     * errors — those propagate as VivaApiError unchanged.
     *
     * @see references/viva-docs/md/payment-isv-api.txt:1
     * @see references/viva-docs/md/webhooks-for-payments.txt:205 (4865 Order Updated)
     * @see references/viva-docs/md/isv-credentials.txt:107 (reseller basic-auth)
     * @see docs/plans/vendure-plugin-v0.md §D15 (reseller fallback scope)
     */
    async cancelOrder(orderCode, opts = {}) {
        // Resolve URL per mode. In merchant mode `opts.merchantId` is silently
        // ignored. In ISV mode it is required.
        const { path, query } = buildOrderCancelUrl(this.mode, orderCode, opts.merchantId);
        const requestOpts = {
            method: 'DELETE',
            path,
            query,
            idempotent: true, // idempotent per Viva docs
            endpoint: 'DELETE /checkout/v2/orders/{orderCode}',
        };
        let raw;
        try {
            raw = await this.client.request(requestOpts);
        }
        catch (err) {
            // 401 → reseller fallback (D15). Only attempt if secondaryClient is present.
            // A 401 from the secondary surfaces immediately — no further retry.
            // @see docs/plans/vendure-plugin-v0.md §D15
            // @see references/viva-docs/md/isv-credentials.txt:107
            if (err instanceof index_js_1.VivaAuthError && err.httpStatus === 401 && this.secondaryClient) {
                raw = await this.secondaryClient.request(requestOpts);
            }
            else {
                throw err;
            }
        }
        return {
            orderCode: raw.OrderCode,
            errorCode: raw.ErrorCode,
            errorText: raw.ErrorText,
        };
    }
}
exports.Payments = Payments;
//# sourceMappingURL=client.js.map