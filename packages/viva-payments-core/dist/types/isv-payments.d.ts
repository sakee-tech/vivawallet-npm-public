/**
 * ISV Payment API request and response types.
 *
 * Covers: CreatePaymentOrder, RetrieveTransaction, RefundTransaction,
 * CancelOrder. All amounts are in integer minor units (bigint) per plan P15.
 *
 * The ISV Payment API uses the same Smart Checkout order-creation endpoint
 * as the standard Payment API but with an additional `merchantId` query
 * parameter to scope the payment to a specific connected merchant.
 *
 * Type attribution: structure referenced from @nkhind/vivawallet-sdk with
 * fresh hand-rolled definitions. No code copied.
 *
 * @see references/viva-docs/md/payment-isv-api.txt:1
 * @see references/viva-docs/md/wh-transaction-payment-created.txt:158
 * @see references/viva-docs/md/webhooks-for-payments.txt:248
 */
import type { CurrencyCode, MinorUnits, OrderCode, TransactionId } from './common.js';
/**
 * Request body for ISV Create Payment Order.
 *
 * Sent as `POST /checkout/v2/orders?merchantId={merchantId}` with a bearer
 * token. The `amount` field MUST be in integer minor units (e.g. 1234 for
 * EUR 12.34). The `currencyCode` is the ISO 4217 numeric string.
 *
 * @see references/viva-docs/md/payment-isv-api.txt:1
 */
export interface CreateOrderRequest {
    /**
     * Payment amount in integer minor units.
     * Wire format is a JSON integer; internally held as bigint.
     * Example: 1234 for EUR 12.34.
     */
    readonly amount: MinorUnits;
    /**
     * ISO 4217 numeric currency code string (e.g. "978" for EUR).
     *
     * @see references/viva-docs/md/wh-transaction-payment-created.txt:487
     */
    readonly currencyCode: CurrencyCode;
    /**
     * Merchant-facing transaction reference (max 50 chars).
     * Stored on the order and returned in webhook EventData.MerchantTrns.
     */
    readonly merchantTrns?: string;
    /**
     * Customer-facing transaction description shown on Smart Checkout page
     * and bank statement (max 255 chars).
     */
    readonly customerTrns?: string;
    /** Customer email used for receipt and 3DS. */
    readonly customerEmail?: string;
    /** Customer phone number. */
    readonly customerPhone?: string;
    /** Customer full name. */
    readonly customerFullName?: string;
    /**
     * @deprecated NOT transmitted to Viva. The Smart Checkout createOrder body has
     * no generic success-redirect field; the post-payment redirect target is a
     * property of the payment SOURCE (`pathSuccess`, set via `POST /api/sources`),
     * not of an individual order. This field is retained for source-compat only
     * and is ignored by `createOrder`. See sakee-tech/vivawallet-npm-public#15.
     */
    readonly successUrl?: string;
    /**
     * @deprecated NOT transmitted to Viva. createOrder supports only `urlFail` +
     * `stateId=1` (redirect on EXPIRY), not a generic failure redirect; the normal
     * post-payment redirect target is the source's `pathFail` (set via
     * `POST /api/sources`). Retained for source-compat only and ignored by
     * `createOrder`. See sakee-tech/vivawallet-npm-public#15.
     */
    readonly failureUrl?: string;
    /**
     * Arbitrary tags for reporting purposes (max 10 entries, each max 50 chars).
     *
     * @see references/viva-docs/md/wh-transaction-payment-created.txt:218
     */
    readonly tags?: readonly string[];
    /**
     * Payment source code. Required for physical-location ISV sources.
     * Omit to use the account default ("Default") source.
     *
     * @see references/viva-docs/md/payment-source-for-isv.txt:101
     */
    readonly sourceCode?: string;
    /**
     * Number of installments (1 = no installments).
     * Must be agreed with Viva; not supported in all markets.
     */
    readonly paymentTimeoutSeconds?: number;
    /** Pre-selected payment method (e.g. 'card'). */
    readonly preselectedPaymentMethod?: string;
    /**
     * ISV fee in integer minor units. ISV-mode only.
     *
     * Stripped from the wire body when `Payments.mode === 'merchant'` — only
     * sent on `POST /checkout/v2/isv/orders` calls. Callers may set this on a
     * single `CreateOrderRequest` regardless of mode; the client will drop it
     * in merchant mode and forward it in ISV mode.
     *
     * @see references/viva-docs/md/isv-partner-program.txt:296
     */
    readonly isvAmount?: MinorUnits;
}
/**
 * Response from ISV Create Payment Order.
 *
 * On success (HTTP 200), Viva returns an `orderCode` which serves as the
 * unique identifier of the created order. Build the Smart Checkout redirect
 * URL as: `{smartCheckoutBaseUrl}?ref={orderCode}&color=%23{hex}`.
 *
 * @see references/viva-docs/md/payment-isv-api.txt:1
 */
export interface CreateOrderResponse {
    /**
     * Order code (int64) uniquely identifying this payment order globally.
     * Used to build the Smart Checkout redirect URL and correlate webhooks.
     * Stored as bigint to preserve precision.
     *
     * @see references/viva-docs/md/wh-transaction-payment-created.txt:176
     */
    readonly orderCode: OrderCode;
}
/**
 * Response from ISV Retrieve Transaction Details.
 *
 * Call as `GET /checkout/v2/transactions/{transactionId}?merchantId={merchantId}`.
 * Per Viva docs, this SHOULD be called before updating local state on any
 * webhook delivery.
 *
 * @see references/viva-docs/md/webhooks-for-payments.txt:248
 * @see references/viva-docs/md/wh-transaction-payment-created.txt:119
 */
export interface RetrieveTransactionResponse {
    /** Unique transaction identifier. */
    readonly transactionId: TransactionId;
    /** The order this transaction belongs to. */
    readonly orderCode: OrderCode;
    /**
     * Transaction status letter from Viva.
     * Use `VivaStatusLetter` from status.ts for the exhaustive set.
     *
     * @see references/viva-docs/md/wh-transaction-payment-created.txt:398
     */
    readonly statusId: string;
    /**
     * Transaction amount in integer minor units.
     * NOTE: Viva docs show `Amount` as `decimal` in some webhook payloads but
     * the createOrder request uses integer minor units. Treat as minor units
     * unless a live demo payment confirms otherwise.
     *
     * TODO(impl): verify Amount unit (minor int vs major decimal) against
     * first real demo payment end-to-end.
     * @see references/viva-docs/md/wh-transaction-payment-created.txt:345
     */
    readonly amount: MinorUnits;
    /** ISO 4217 numeric currency code. */
    readonly currencyCode: CurrencyCode;
    /** Merchant ID that owns this transaction. */
    readonly merchantId: string;
    /** Parent transaction ID if this is a refund. */
    readonly parentId: TransactionId | null;
    /** ISO 8601 timestamp when the transaction was inserted. */
    readonly insDate: string;
    /** Transaction type numeric identifier. */
    readonly transactionTypeId: number;
    /** Masked card number (e.g. "414746XXXXXX0133"). */
    readonly cardNumber?: string;
    /** Card type identifier (0=Visa, 1=Mastercard, etc.). */
    readonly cardTypeId?: number;
    /**
     * Card scheme name derived from `cardTypeId` via
     * {@link import('./card-types.js').resolveCardType resolveCardType}.
     *
     * Emitted as `'Visa' | 'MasterCard' | 'Maestro' | 'Amex' | 'Diners' |
     * 'Discover' | 'JCB'` for known card schemes. `undefined` when the
     * upstream `cardTypeId` is absent, `4` (Invalid), `5` (Unknown), or any
     * value not in the documented mapping.
     *
     * Consumed by `resolveRefundStrategy()` in the refunds module to decide
     * Fast vs Standard refund routing.
     *
     * @see ./card-types.ts
     * @see ../refunds/strategy.ts
     */
    readonly cardType?: string;
    /** Customer email. */
    readonly email?: string;
    /** Customer full name. */
    readonly fullName?: string;
    /** Merchant-facing reference string. */
    readonly merchantTrns?: string;
    /** Customer-facing reference string. */
    readonly customerTrns?: string;
    /** Connected account ID if ISV scoped. */
    readonly connectedAccountId?: string;
}
/**
 * Request body for ISV Refund Transaction.
 *
 * Sent as `POST /checkout/v2/transactions/{transactionId}` with a bearer
 * or reseller token. Partial refunds are supported by specifying `amount`.
 * If `amount` is omitted, a full refund is issued.
 *
 * Per plan P18: validate `amount <= (captured - already_refunded)` before
 * calling Viva. ISV fee reverses automatically on full/partial refund.
 *
 * @see references/viva-docs/md/isv-partner-program.txt:296
 */
export interface RefundRequest {
    /**
     * Refund amount in integer minor units.
     * Must be <= (captured_amount - already_refunded_amount).
     * Omit for a full refund.
     */
    readonly amount?: MinorUnits;
    /** Merchant reference for this refund. */
    readonly merchantTrns?: string;
    /** Customer reference for this refund. */
    readonly customerTrns?: string;
    /** Source code. Required for ISV refunds in some configurations. */
    readonly sourceCode?: string;
}
/**
 * Response from ISV Refund Transaction.
 *
 * Returned by the legacy `POST /api/transactions/{transactionId}` endpoint.
 * Viva returns PascalCase field names; the SDK normalises to camelCase.
 *
 * Probe-verified 2026-04-25: the legacy endpoint is the ONLY supported refund path.
 * `POST /checkout/v2/transactions/{id}` (v2/OAuth2) returns 405 on Viva sandbox.
 *
 * @see references/viva-docs/md/tut-create-recurring-payment.txt:288
 */
export interface RefundResponse {
    /** ID of the newly created refund transaction. */
    readonly transactionId: TransactionId;
    /** Viva status identifier for the refund transaction. */
    readonly statusId?: string;
    /** Refunded amount in minor units (echoed from request). */
    readonly amount?: MinorUnits;
}
/**
 * Response from ISV Cancel Order.
 *
 * Sent as `DELETE /checkout/v2/orders/{orderCode}?merchantId={merchantId}`.
 * Used for orders that have not yet been paid. Idempotent — cancelling an
 * already-cancelled or captured order returns the existing Viva response.
 *
 * Note: per plan Q5, cancelOrder may require ResellerBasicAuthStrategy.
 * Confirm during S2/S3 implementation.
 *
 * @see references/viva-docs/md/payment-isv-api.txt:1
 */
export interface CancelOrderResponse {
    /** Order code of the cancelled order. */
    readonly orderCode: OrderCode;
    /**
     * HTTP status code returned by Viva.
     * Typically 200 on success.
     *
     * TODO(impl): verify exact response body shape for cancelOrder via demo.
     * @see references/viva-docs/md/payment-isv-api.txt:1
     */
    readonly errorCode: number;
    readonly errorText: string;
}
//# sourceMappingURL=isv-payments.d.ts.map