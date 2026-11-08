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
import type { IsvHttpClient } from '../isv/client.js';
import type { BasicAuthClient } from '../legacy/client.js';
import type { CreateOrderRequest, CreateOrderResponse, RetrieveTransactionResponse, RefundResponse, ListedRefund, CancelOrderResponse, RetrieveOrderResponse, MerchantId, TransactionId, OrderCode, MinorUnits } from '../types/index.js';
/**
 * Payment surface mode.
 *
 *   - `merchant` — Single-merchant integration. URLs do NOT include the
 *     `/isv` segment and do NOT carry `merchantId` query parameter. The
 *     OAuth2 token is scoped to a single merchant account.
 *   - `isv`      — ISV/partner integration. URLs include the `/isv` segment
 *     where applicable and carry `merchantId={uuid}` to scope the call to a
 *     specific connected merchant.
 *
 * @see docs/AUTH.md §3.1
 * @see docs/ENDPOINTS.md §2.1 / §2.2
 */
export type PaymentsMode = 'merchant' | 'isv';
/**
 * Configuration for the {@link Payments} client.
 *
 * - `mode` REQUIRED. Determines URL paths + query-string contract.
 * - `client` primary OAuth2 client.
 * - `secondaryClient` optional 401-fallback client for retrieveTransaction
 *   and cancelOrder (reseller basic-auth scenario; see D15).
 * - `legacyClient` REQUIRED for refundPayment in both modes (legacy host +
 *   Basic auth — v2 path returns 405).
 */
export interface PaymentsConfig {
    readonly mode: PaymentsMode;
    readonly client: IsvHttpClient;
    readonly secondaryClient?: IsvHttpClient;
    readonly legacyClient?: BasicAuthClient;
}
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
export declare class Payments {
    private readonly mode;
    private readonly client;
    private readonly secondaryClient;
    private readonly legacyClient;
    constructor(config: PaymentsConfig);
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
     * Non-idempotent: does not retry on 4xx/5xx (only a connection error where the request never left).
     *
     * @see references/viva-docs/md/payment-isv-api.txt:1
     * @see references/viva-docs/md/isv-partner-program.txt:61 (P14 idempotency)
     * @see references/viva-docs/md/isv-partner-program.txt:83 (P15 amounts)
     */
    createOrder(req: CreateOrderRequest, opts: {
        merchantId?: MerchantId;
        idempotencyKey: string;
    }): Promise<CreateOrderResponse>;
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
    retrieveTransaction(transactionId: TransactionId, opts?: {
        merchantId?: MerchantId;
    }): Promise<RetrieveTransactionResponse>;
    /**
     * Issue a full or partial refund (Viva's "Cancel transaction") for a captured
     * transaction.
     *
     * CONTRACT (verified against the OpenAPI specs on disk):
     *   `DELETE /api/transactions/{transactionId}` on the LEGACY HOST
     *   (`demo.vivapayments.com` / `www.vivapayments.com`) with Basic auth.
     *   Parameters go in the QUERY STRING, not a body:
     *     `?amount={minorUnits}&sourceCode={code}&idempotencyKey={key}&currencyCode={iso4217-numeric}`
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
     *   - `amountMinor > 0` is REQUIRED and always emitted as `?amount=` — the ISV
     *     spec marks `amount` `required: true`. A full refund passes the full
     *     captured amount explicitly.
     *   - Viva enforces a CUMULATIVE cap per transaction (probe 2026-10-24): an
     *     over-cap or repeated full refund comes back HTTP 200 with
     *     `ErrorCode 403` (PaymentsNonReversibleTransaction /
     *     PaymentsRefundFailedTotalAmountExceeded) → VivaApiError below.
     *
     *   - ISV fee reverses automatically on refund (isv-partner-program.txt:296).
     *   - Failed refund (4xx) surfaces as VivaApiError; payment NOT marked refunded.
     *
     * Idempotency (#2): `idempotencyKey` is sent as the `idempotencyKey` QUERY
     * param. Viva honours it — a repeat call with the same key returns the first
     * call's body (same TransactionId) and moves no money (probe 2026-10-24;
     * the `Idempotency-Key` HEADER is ignored). Retention window: UNVERIFIED.
     * The transport still does not retry on 4xx/5xx.
     *
     * Viva response fields (PascalCase, mapped to camelCase):
     *   StatusId → statusId, Amount → amount, TransactionId → transactionId.
     *
     * @see references/viva-docs/md/isv-partner-program.txt:296 (ISV fee reversal on refund)
     */
    refundPayment(transactionId: TransactionId, opts: {
        merchantId: MerchantId;
        /** Refund amount in minor units, > 0. Required (spec `amount: required`). */
        amountMinor: MinorUnits;
        sourceCode?: string;
        /** ISO 4217 numeric currency code (e.g. 978 for EUR). Optional. */
        currencyCode?: number;
        /** Forwarded as the `idempotencyKey` query param; Viva dedupes on it. */
        idempotencyKey: string;
        /**
         * Forwarded as the optional `merchantTrns` query param (spec: no documented
         * max length). Viva stores it on the refund row and echoes it on
         * retrieve, so a retry can recognise its own refund (#2).
         */
        merchantTrns?: string;
        /**
         * Per-call Basic-auth client override. ISV mode passes a Reseller-variant
         * client built with the *connected* merchant's UUID, since the refund must
         * authenticate as the reseller scoped to that merchant. When omitted, the
         * construction-time `legacyClient` (Merchant Basic) is used.
         */
        legacyClient?: BasicAuthClient;
    }): Promise<RefundResponse>;
    /**
     * List the finished refunds of one payment, as Viva sees them.
     *
     * Used on a refund retry to reconcile against what Viva really refunded
     * before resending (#2). FAIL-CLOSED: any doubt throws, so the caller refuses
     * the refund instead of resending blindly.
     *
     * CONTRACT (probe-verified 2026-10-24/25, ISV reseller Basic):
     *   `GET /api/transactions?ordercode={orderCode}` on the LEGACY HOST with Basic
     *   auth (same legacyClient resolution as refundPayment: per-call Reseller
     *   variant in ISV mode, construction-time Merchant Basic otherwise).
     *   Lists the payment plus one row per refund: `ParentId` = payment's
     *   TransactionId, negative MAJOR-unit `Amount`, `StatusId 'F'`. Rows carry no
     *   top-level TransactionTypeId and may lack CurrencyCode, so the currency is
     *   taken from the parent row; parent absent → throw.
     *   Matched on `ParentId`, not order — one order can hold several payment attempts.
     *   Previous-day refunds appear in the same shape (no time window needed).
     *   Each row carries `MerchantTrns`: the full tag sent on the refund DELETE
     *   (60 chars probed untruncated), `null` when sent without one
     *   (logs/refund-cap-probe/2026-10-25T14-11-05-485Z/status.json).
     *
     * CAVEATS:
     *   - Deprecated: merchant spec tags it "Transactions (Deprecated)",
     *     `deprecated: true` (docs/internal/payment-api.yaml ~8495-8524); absent
     *     from the ISV spec. Works today; Viva may remove it without notice.
     *   - Pagination undocumented; probed orders had at most 4 rows.
     *
     * ponytail: rides a deprecated, unpaginated endpoint — ceiling is Viva removing
     * it or truncating long listings. Upgrade path: a supported per-transaction
     * refund listing if Viva ships one, else local refund ledger as source of truth.
     *
     * Throws VivaApiError on HTTP error, `Success:false`, `ErrorCode != 0`,
     * missing/non-array `Transactions`, or missing parent row.
     *
     * @see docs/internal/payment-api.yaml:8496 (GET /api/transactions, deprecated, `orderCode` query)
     * @see docs/brain/viva-api-endpoints.md "Refund listing"
     */
    listRefunds(orderCode: OrderCode, parentTransactionId: TransactionId, opts?: {
        merchantId?: MerchantId;
        legacyClient?: BasicAuthClient;
    }): Promise<ListedRefund[]>;
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
    cancelOrder(orderCode: OrderCode, opts?: {
        merchantId?: MerchantId;
        legacyClient?: BasicAuthClient;
    }): Promise<CancelOrderResponse>;
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
    retrieveOrder(orderCode: OrderCode, opts?: {
        merchantId?: MerchantId;
        legacyClient?: BasicAuthClient;
        currencyCode?: number;
    }): Promise<RetrieveOrderResponse>;
}
//# sourceMappingURL=client.d.ts.map