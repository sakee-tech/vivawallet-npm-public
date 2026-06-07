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
export {};
//# sourceMappingURL=isv-payments.js.map