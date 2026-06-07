/**
 * IsvPayments — ISV Payment API methods.
 *
 * Covers:
 *   - createOrder         → POST /checkout/v2/orders?merchantId={merchantId} (OAuth2)
 *   - retrieveTransaction → GET /checkout/v2/transactions/{transactionId}    (OAuth2)
 *   - refundPayment       → POST /api/transactions/{transactionId}           (Legacy/Basic)
 *   - cancelOrder         → DELETE /checkout/v2/orders/{orderCode}           (OAuth2)
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
import type { IsvHttpClient } from './client.js';
import type { LegacyBasicClient } from './legacy-basic-client.js';
import type { CreateOrderRequest, CreateOrderResponse, RetrieveTransactionResponse, RefundResponse, CancelOrderResponse, MerchantId, TransactionId, OrderCode, MinorUnits } from '../types/index.js';
/**
 * ISV Payment API client.
 *
 * Constructed with an IsvHttpClient instance shared across all ISV modules.
 * Each method scopes its request to a specific merchant via the merchantId
 * query parameter per the ISV integration model.
 *
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
 * @see references/viva-docs/md/tut-create-recurring-payment.txt:288 (legacy refund path)
 * @see references/viva-docs/md/payment-isv-api.txt:1
 * @see references/viva-docs/md/isv-partner-program.txt:61 (P1: merchant scoping)
 * @see references/viva-docs/md/isv-credentials.txt:107 (reseller credentials)
 * @see docs/plans/vendure-plugin-v0.md §D15 (reseller fallback)
 */
export declare class IsvPayments {
    private readonly client;
    private readonly secondaryClient?;
    private readonly legacyClient?;
    constructor(client: IsvHttpClient, secondaryClient?: IsvHttpClient | undefined, legacyClient?: LegacyBasicClient | undefined);
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
    createOrder(req: CreateOrderRequest, opts: {
        merchantId: MerchantId;
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
    refundPayment(transactionId: TransactionId, opts: {
        merchantId: MerchantId;
        amountMinor?: MinorUnits;
        sourceCode?: string;
        idempotencyKey: string;
    }): Promise<RefundResponse>;
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
    cancelOrder(orderCode: OrderCode, opts: {
        merchantId: MerchantId;
    }): Promise<CancelOrderResponse>;
}
//# sourceMappingURL=payments.d.ts.map