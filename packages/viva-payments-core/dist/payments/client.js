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
const currency_exponent_js_1 = require("../types/currency-exponent.js");
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
        // Viva rejects orders below its global minimum of 30 minor units
        // (payment-isv-api.yaml:5315 `minimum: 30`). Catch it locally so the caller
        // gets a clear error instead of an opaque Viva 4xx.
        if (req.amount < 30n) {
            throw new index_js_1.VivaValidationError({
                message: `createOrder: amount must be >= 30 minor units (Viva minimum), got ${req.amount}`,
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
        // Customer identity is a NESTED object on Viva's Smart Checkout createOrder
        // body: `customer: { email, fullName, phone, countryCode, requestLang }`.
        // Emitting these at the top level (as earlier versions did) made Viva
        // silently drop them — the same footgun as successUrl/failureUrl below.
        // @see docs/internal/payment-isv-api.yaml:380 (customer object)
        const customer = {};
        if (req.customerEmail !== undefined)
            customer['email'] = req.customerEmail;
        if (req.customerPhone !== undefined)
            customer['phone'] = req.customerPhone;
        if (req.customerFullName !== undefined)
            customer['fullName'] = req.customerFullName;
        if (Object.keys(customer).length > 0)
            wireBody['customer'] = customer;
        // NOTE: `successUrl` / `failureUrl` are intentionally NOT emitted. Viva's
        // Smart Checkout createOrder body (`Create_New_Payment_Order_v2_schema`) has
        // no generic success/failure redirect field — only `urlFail` + `stateId=1`
        // (redirect on EXPIRY). The post-payment redirect target is a property of the
        // payment SOURCE (`pathSuccess` / `pathFail`, set via POST /api/sources), not
        // of an individual order. Sending `successUrl` / `failureUrl` here just
        // shipped fields Viva silently dropped — a footgun that made the plugin
        // config look load-bearing when it was inert. See
        // sakee-tech/vivawallet-npm-public#15. The fields remain on the request type
        // (deprecated) for source-compat but are never transmitted.
        if (req.tags !== undefined)
            wireBody['tags'] = req.tags;
        if (req.sourceCode !== undefined)
            wireBody['sourceCode'] = req.sourceCode;
        if (req.paymentTimeoutSeconds !== undefined)
            wireBody['paymentTimeout'] = req.paymentTimeoutSeconds;
        // NOTE: `preselectedPaymentMethod` is intentionally NOT emitted. No such field
        // exists on Viva's Smart Checkout createOrder body (grep of payment-api.yaml +
        // payment-isv-api.yaml: zero hits). Sending it just shipped a field Viva
        // silently dropped — the same footgun as successUrl/failureUrl above. The field
        // remains on the request type (deprecated) for source-compat but is never
        // transmitted. Payment-method preselection is done via the checkout URL /
        // source configuration, not the order body.
        // ISV-only: `isvAmount` only emitted in ISV mode AND only when set. Although
        // the OpenAPI marks isvAmount required, Viva rejects an isvAmount below its
        // minimum (≈30), so a 0 fee must be OMITTED, not sent as 0 — verified by
        // dogfooding (sakee-tech/vivawallet-npm-public#7). Stripped entirely in
        // merchant mode even if the caller passed it (forward-compat shim).
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
        // Viva's modern checkout/v2 create-order response returns the code as
        // lowercase `orderCode` (verified live + OpenAPI); read both casings
        // defensively, as retrieveTransaction already does. Reading only
        // `OrderCode` here silently dropped the code on every real response,
        // orphaning the order on Viva's side. (sakee-tech/vivawallet-npm-public#9)
        return { orderCode: (raw.orderCode ?? raw.OrderCode) };
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
        if (typeof transactionId !== 'string' || transactionId.trim() === '') {
            throw new index_js_1.VivaValidationError({
                message: 'retrieveTransaction: transactionId is required and must be a non-empty string',
            });
        }
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
        // CurrencyCode is needed BOTH for the response field and to convert the
        // major-unit `Amount` decimal into minor units below. The schema/example
        // disagree on int vs string (978 vs "978"), so coerce to string defensively.
        const currencyCodeRaw = raw['currencyCode'] ?? raw['CurrencyCode'];
        // Derive cardType (string scheme name) from Viva's numeric cardTypeId.
        // Pure mapping via resolveCardType — undefined when id is absent, a
        // sentinel (Invalid/Unknown), or otherwise unmapped.
        // @see ../types/card-types.ts
        // @see ../refunds/strategy.ts (consumer)
        const cardType = typeof cardTypeId === 'number' ? (0, card_types_js_1.resolveCardType)(cardTypeId) : undefined;
        // Build with conditional optional fields to satisfy exactOptionalPropertyTypes.
        // (Cannot assign to readonly Partial<> properties so we use spread.)
        return {
            // The v2 GET transaction response does NOT echo transactionId in the body
            // (not in the `transactions` schema, payment-isv-api.yaml:6258). Fall back to
            // the path-parameter id the caller passed in — mirrors refundPayment.
            transactionId: (raw['transactionId'] ?? raw['TransactionId'] ?? transactionId),
            orderCode,
            statusId: (raw['statusId'] ?? raw['StatusId']),
            // Viva returns `Amount` in MAJOR units as a decimal (e.g. 23.17), NOT
            // minor units. Convert exponent-aware so the result is the minor-unit
            // bigint the type contract promises. The old `BigInt(...)` threw on any
            // non-whole amount (sakee-tech/vivawallet-npm-public#20) AND mis-scaled
            // whole amounts (5.00 → 5 instead of 500).
            amount: (0, currency_exponent_js_1.majorToMinor)((raw['amount'] ?? raw['Amount'] ?? 0), currencyCodeRaw),
            // Coerce to string — see currencyCodeRaw note above.
            currencyCode: String(currencyCodeRaw ?? ''),
            // The v2 transactions schema does NOT echo merchantId; fall back to the
            // caller-supplied query-param id (mirrors the transactionId fallback)
            // instead of leaving a required string undefined.
            merchantId: (raw['merchantId'] ?? raw['MerchantId'] ?? opts.merchantId ?? ''),
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
     * Issue a full or partial refund (Viva's "Cancel transaction") for a captured
     * transaction.
     *
     * CONTRACT (verified against the OpenAPI specs on disk):
     *   `DELETE /api/transactions/{transactionId}` on the LEGACY HOST
     *   (`demo.vivapayments.com` / `www.vivapayments.com`) with Basic auth.
     *   Parameters go in the QUERY STRING, not a body:
     *     `?amount={minorUnits}&sourceCode={code}&currencyCode={iso4217-numeric}`
     *   Success is indicated by `StatusId === 'F'` (finished/finalised).
     *   @see docs/internal/payment-api.yaml:8592      (merchant Cancel transaction)
     *   @see docs/internal/payment-isv-api.yaml:2640   (ISV Cancel transaction)
     *
     * AUTH per mode (the caller wires the correct `legacyClient`):
     *   - merchant: Merchant Basic — `base64(MerchantId:ApiKey)`.
     *   - isv:      Reseller Basic — `base64(ResellerId:ConnectedMerchantId:ResellerApiKey)`.
     *     The Reseller ID/Key are issued by Viva (demo + production pairs differ)
     *     and are distinct from the dashboard ISV credentials.
     *     @see docs/internal/payment-isv-api.yaml:2650 (reseller auth structure)
     *
     *   This method calls `legacyClient` DIRECTLY; the OAuth2 401-fallback does not
     *   apply. If `legacyClient` is absent, throws VivaValidationError.
     *
     * Amount handling:
     *   - Partial refund: provide `amountMinor > 0` → emitted as `?amount=`.
     *   - Full refund: omit `amountMinor` → `amount` query param omitted. Viva
     *     treats a missing amount as a full refund (Viva Support, 2026-06-11),
     *     though the ISV OpenAPI marks `amount` required; callers that want strict
     *     conformance should pass the full captured amount explicitly.
     *
     *   - ISV fee reverses automatically on refund (isv-partner-program.txt:296).
     *   - Failed refund (4xx) surfaces as VivaApiError; payment NOT marked refunded.
     *
     * Non-idempotent: does not retry on 4xx/5xx.
     *
     * Viva response fields (PascalCase, mapped to camelCase):
     *   StatusId → statusId, Amount → amount, TransactionId → transactionId.
     *
     * @see references/viva-docs/md/isv-partner-program.txt:296 (ISV fee reversal on refund)
     */
    async refundPayment(transactionId, opts) {
        // Local validation per P18
        if (typeof transactionId !== 'string' || transactionId.trim() === '') {
            throw new index_js_1.VivaValidationError({
                message: 'refundPayment: transactionId is required and must be a non-empty string',
            });
        }
        if (opts.amountMinor !== undefined && opts.amountMinor <= 0n) {
            throw new index_js_1.VivaValidationError({
                message: `refundPayment: amountMinor must be > 0 when specified, got ${opts.amountMinor}`,
            });
        }
        // legacyClient REQUIRED for refund — DELETE /api/transactions/{id} on the
        // legacy host with Basic auth. Merchant mode: Merchant Basic (construction
        // time). ISV mode: the caller passes a Reseller-variant client per-call via
        // opts.legacyClient (Viva-issued reseller creds + connected merchant UUID).
        const legacyClient = opts.legacyClient ?? this.legacyClient;
        if (!legacyClient) {
            throw new index_js_1.VivaValidationError({
                message: 'refundPayment requires a legacyClient (Basic auth). ' +
                    'Merchant mode: configure the Merchant Basic pair (MerchantId + ApiKey). ' +
                    'ISV mode: configure the Viva-issued Reseller pair (resellerId + resellerApiKey).',
            });
        }
        // Build query string for the DELETE Cancel-transaction call.
        // - amount: send only for partial refund; omit for full refund.
        // - sourceCode: defaults to 'Default' (the source the refund is applied to).
        // - currencyCode: optional ISO 4217 numeric (multicurrency refunds).
        // @see docs/internal/payment-isv-api.yaml:2673 (query parameters)
        const query = {
            sourceCode: opts.sourceCode ?? 'Default',
        };
        if (opts.amountMinor !== undefined) {
            // Viva endpoint expects amount in minor units as integer.
            query['amount'] = opts.amountMinor;
        }
        if (opts.currencyCode !== undefined) {
            query['currencyCode'] = opts.currencyCode;
        }
        const result = await legacyClient.request({
            method: 'DELETE',
            path: `/api/transactions/${transactionId}`,
            query,
            idempotent: false, // non-idempotent — no 4xx/5xx retry
            endpoint: 'DELETE /api/transactions/{transactionId}',
        });
        const raw = result.data;
        // Success gate: Viva models failure on a 200 via Success:false / ErrorCode!=0
        // (delete_transaction schema: ErrorCode 0 = success). Without this a rejected
        // refund would be reported to the caller as successful.
        if (raw.Success === false || (typeof raw.ErrorCode === 'number' && raw.ErrorCode !== 0)) {
            throw new index_js_1.VivaApiError({
                message: `Viva refund rejected: ${raw.ErrorText ?? 'unknown error'} (ErrorCode ${raw.ErrorCode ?? 'n/a'})`,
                httpStatus: 200,
                ...(raw.ErrorCode !== undefined ? { vivaCode: String(raw.ErrorCode) } : {}),
            });
        }
        // Map PascalCase → camelCase. `Amount` is a MAJOR-unit decimal — convert
        // exponent-aware to minor units (same asymmetry as retrieveTransaction;
        // `BigInt(raw.Amount)` threw on any decimal refund).
        return {
            transactionId: (raw.TransactionId ?? transactionId),
            ...(raw.StatusId !== undefined ? { statusId: raw.StatusId } : {}),
            ...(raw.Amount !== undefined
                ? { amount: (0, currency_exponent_js_1.majorToMinor)(raw.Amount, raw.CurrencyCode ?? opts.currencyCode) }
                : {}),
        };
    }
    /**
     * Cancel an order that has not yet been paid.
     *
     * Per plan P18: cancellation triggers webhook 4865 (Order Updated).
     *
     * CONTRACT (verified against live demo, 2026-06-13 — see
     * docs/internal/viva-cancel-probes/*-findings.md):
     *   `DELETE /api/orders/{orderCode}` on the LEGACY HOST
     *   (`demo.vivapayments.com` / `www.vivapayments.com`) with Basic auth.
     *   Success → 200 `{ OrderCode, ErrorCode: 0, ErrorText: null, Success: true }`.
     *
     *   The v2/OAuth2 route `DELETE /checkout/v2/orders/{orderCode}` does NOT exist
     *   — it returns an empty 404 for every order (even GET-by-code 404s), so the
     *   whole order-by-code resource is unavailable on `demo-api`/OAuth2. Cancel
     *   lives on the legacy host, exactly like refundPayment's cancel-transaction.
     *
     * AUTH per mode (the caller wires the correct `legacyClient`):
     *   - merchant: Merchant Basic — `base64(MerchantId:ApiKey)`.
     *   - isv:      Reseller Basic — `base64(ResellerId:ConnectedMerchantId:ResellerApiKey)`.
     *     The caller passes a Reseller-variant client per-call via `opts.legacyClient`,
     *     since the cancel must authenticate as the reseller scoped to the connected
     *     merchant — an ISV never holds the connected merchant's ApiKey.
     *
     *   This method calls `legacyClient` DIRECTLY (no OAuth2 / 401-fallback). If
     *   `legacyClient` is absent, throws VivaValidationError.
     *
     * Idempotent (verified): re-cancelling an already-cancelled order returns 200
     * `Success: true`, not a 4xx — so the retry-on-5xx safety is sound and a second
     * cancel is harmless.
     *
     * @see docs/internal/viva-cancel-probes/viva-cancel-order-findings.md          (v2/OAuth2 route → 404)
     * @see docs/internal/viva-cancel-probes/viva-cancel-legacy-findings.md         (merchant legacy → 200)
     * @see docs/internal/viva-cancel-probes/viva-cancel-isv-reseller-findings.md   (ISV reseller legacy → 200, idempotent)
     * @see references/viva-docs/md/webhooks-for-payments.txt:205 (4865 Order Updated)
     */
    async cancelOrder(orderCode, opts = {}) {
        if (typeof orderCode !== 'bigint' || orderCode <= 0n) {
            throw new index_js_1.VivaValidationError({
                message: `cancelOrder: orderCode is required and must be a positive bigint, got ${String(orderCode)}`,
            });
        }
        // legacyClient REQUIRED — DELETE /api/orders/{oc} on the legacy host with
        // Basic auth. Merchant mode: Merchant Basic (construction-time legacyClient).
        // ISV mode: a Reseller-variant client passed per-call (reseller creds +
        // connected merchant UUID), mirroring refundPayment.
        const legacyClient = opts.legacyClient ?? this.legacyClient;
        if (!legacyClient) {
            throw new index_js_1.VivaValidationError({
                message: 'cancelOrder requires a legacyClient (Basic auth). ' +
                    'Merchant mode: configure the Merchant Basic pair (MerchantId + ApiKey). ' +
                    'ISV mode: pass a Reseller-variant client (resellerId + connectedMerchantId + resellerApiKey).',
            });
        }
        const result = await legacyClient.request({
            method: 'DELETE',
            path: `/api/orders/${orderCode}`,
            idempotent: true, // verified idempotent: re-cancel returns 200 Success
            endpoint: 'DELETE /api/orders/{orderCode}',
        });
        const raw = result.data;
        // Response fields are PascalCase per the spec sample — `OrderCode`,
        // `ErrorCode`, `ErrorText`, `Success` (payment-isv-api.yaml:1030-1041,
        // ISV_Cancel_Order 200 example; identical to the DELETE /api/transactions
        // refund response). So `raw.ErrorCode` is the correct key.
        //
        // Success gate: like refund, the legacy host can return 200 with a failure
        // body (Success:false / ErrorCode!=0). A verified re-cancel returns
        // Success:true, so this does not break idempotency. Without it a failed
        // cancel would be reported as a successful void.
        if (raw.Success === false || (typeof raw.ErrorCode === 'number' && raw.ErrorCode !== 0)) {
            throw new index_js_1.VivaApiError({
                message: `Viva cancelOrder rejected: ${raw.ErrorText ?? 'unknown error'} (ErrorCode ${raw.ErrorCode ?? 'n/a'})`,
                httpStatus: 200,
                ...(raw.ErrorCode !== undefined ? { vivaCode: String(raw.ErrorCode) } : {}),
            });
        }
        return {
            orderCode: (raw.OrderCode ?? orderCode),
            errorCode: raw.ErrorCode ?? 0,
            errorText: raw.ErrorText ?? '',
        };
    }
    /**
     * Retrieve a payment order by its order code.
     *
     * CONTRACT (Viva docs):
     *   `GET /api/orders/{orderCode}` on the LEGACY HOST
     *   (`demo.vivapayments.com` / `www.vivapayments.com`) with Basic auth.
     *   There is NO OAuth2/v2 equivalent — `GET /checkout/v2/orders/{oc}` 404s, so
     *   the order-by-code resource lives only on the legacy host, exactly like
     *   cancelOrder.
     *
     * AUTH per mode (the caller wires the correct `legacyClient`):
     *   - merchant: Merchant Basic — base64(MerchantId:ApiKey).
     *   - isv:      Reseller Basic — base64(ResellerId:ConnectedMerchantId:ResellerApiKey),
     *               passed per-call via `opts.legacyClient`.
     *   If `legacyClient` is absent, throws VivaValidationError.
     *
     * Amounts: the response returns `RequestAmount`/`TipAmount` as MAJOR-unit
     * floats and carries NO currency code. They are converted to minor units with
     * the caller-supplied `opts.currencyCode` exponent (default: 2 decimals). Pass
     * `currencyCode` for zero-decimal (JPY) or three-decimal (KWD) currencies.
     *
     * Idempotent (GET — safe to retry on 429/5xx). A 404 (order not found)
     * surfaces as VivaApiError from the HTTP layer.
     *
     * @see docs/internal/payment-isv-api.yaml:786 (GET /api/orders/{order_code})
     */
    async retrieveOrder(orderCode, opts = {}) {
        if (typeof orderCode !== 'bigint' || orderCode <= 0n) {
            throw new index_js_1.VivaValidationError({
                message: `retrieveOrder: orderCode is required and must be a positive bigint, got ${String(orderCode)}`,
            });
        }
        const legacyClient = opts.legacyClient ?? this.legacyClient;
        if (!legacyClient) {
            throw new index_js_1.VivaValidationError({
                message: 'retrieveOrder requires a legacyClient (Basic auth). ' +
                    'Merchant mode: configure the Merchant Basic pair (MerchantId + ApiKey). ' +
                    'ISV mode: pass a Reseller-variant client (resellerId + connectedMerchantId + resellerApiKey).',
            });
        }
        const result = await legacyClient.request({
            method: 'GET',
            path: `/api/orders/${orderCode}`,
            idempotent: true, // GET — safe to retry on 429/5xx
            endpoint: 'GET /api/orders/{orderCode}',
        });
        const raw = result.data;
        return {
            // Echo the path-param orderCode: it is precision-safe (int64 bigint),
            // whereas the legacy client does not run the bigint-safe parser, so the
            // response number could lose precision above 2^53.
            orderCode,
            // RequestAmount/TipAmount are MAJOR-unit floats; convert exponent-aware.
            requestAmount: (0, currency_exponent_js_1.majorToMinor)(raw.RequestAmount ?? 0, opts.currencyCode),
            tipAmount: (0, currency_exponent_js_1.majorToMinor)(raw.TipAmount ?? 0, opts.currencyCode),
            stateId: Number(raw.StateId ?? 0),
            ...(typeof raw.SourceCode === 'string' ? { sourceCode: raw.SourceCode } : {}),
            ...(Array.isArray(raw.Tags) ? { tags: raw.Tags } : {}),
            ...(typeof raw.RequestLang === 'string' ? { requestLang: raw.RequestLang } : {}),
            ...(typeof raw.MerchantTrns === 'string' ? { merchantTrns: raw.MerchantTrns } : {}),
            ...(typeof raw.CustomerTrns === 'string' ? { customerTrns: raw.CustomerTrns } : {}),
            ...(typeof raw.MaxInstallments === 'number' ? { maxInstallments: raw.MaxInstallments } : {}),
            ...(typeof raw.ExpirationDate === 'string' ? { expirationDate: raw.ExpirationDate } : {}),
        };
    }
}
exports.Payments = Payments;
//# sourceMappingURL=client.js.map