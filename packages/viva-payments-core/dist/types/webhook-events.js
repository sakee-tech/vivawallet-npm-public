"use strict";
/**
 * Webhook event types and payloads for the Viva Wallet ISV integration.
 *
 * Covers: WebhookEnvelope<T> generic, EVENT_TYPES const object, and typed
 * EventData payloads for v1-scope event types:
 *   1796 — Transaction Payment Created
 *   1797 — Transaction Reversal Created
 *   1798 — Transaction Failed
 *   4865 — Order Updated (cancellation)
 *   8193 — Account Connected
 *   8194 — Account Verification Status Changed
 *
 * Event 7936 (Sale Transactions) is NOT in v1 scope per plan A8.
 * HMAC verification only applies to 7936; not implemented in v1.
 *
 * @see references/viva-docs/md/webhooks-for-payments.txt:141
 * @see references/viva-docs/md/wh-transaction-payment-created.txt:158
 * @see references/viva-docs/md/wh-transaction-failed.txt:162
 * @see references/viva-docs/md/wh-account-connected.txt:150
 * @see references/viva-docs/md/wh-account-verif-status-changed.txt:152
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.DEFERRED_EVENT_TYPES = exports.EVENT_TYPES = void 0;
// ---------------------------------------------------------------------------
// EventTypeId const object (not a TypeScript enum)
// ---------------------------------------------------------------------------
/**
 * v1-scope Viva Webhook event type identifiers.
 *
 * Defined as `as const` object per requirement 4 — NOT a TypeScript enum.
 * This avoids TypeScript enum pitfalls (numeric reverse-mapping, etc.).
 *
 * @see references/viva-docs/md/webhooks-for-payments.txt:141
 */
exports.EVENT_TYPES = {
    /** A customer payment has been successful. */
    TRANSACTION_PAYMENT_CREATED: 1796,
    /** A customer refund has been successfully actioned. */
    TRANSACTION_REVERSAL_CREATED: 1797,
    /** A customer payment failed. */
    TRANSACTION_FAILED: 1798,
    /** An order was cancelled (API or Smart Checkout back button). */
    ORDER_UPDATED: 4865,
    /** An account is successfully connected to the ISV account. */
    ACCOUNT_CONNECTED: 8193,
    /** Verification status of a connected account changed. */
    ACCOUNT_VERIFICATION_STATUS_CHANGED: 8194,
};
/**
 * Deferred event type IDs — documented for future implementation.
 * NOT in v1 scope per plan A8 and the narrowed event-type set.
 *
 * @see references/viva-docs/md/webhooks-for-payments.txt:141
 */
exports.DEFERRED_EVENT_TYPES = {
    /** Commission payment withdrawn by Viva. Post-v1. */
    TRANSACTION_PRICE_CALCULATED: 1799,
    /** ECR integration only. Post-v1. */
    TRANSACTION_POS_ECR_SESSION_CREATED: 1802,
    /** ECR integration only. Post-v1. */
    TRANSACTION_POS_ECR_SESSION_FAILED: 1803,
    /** Wallet account balance change. Post-v1. */
    ACCOUNT_TRANSACTION_CREATED: 2054,
    /** Bank transfer created. Post-v1. */
    COMMAND_BANK_TRANSFER_CREATED: 768,
    /** Bank transfer executed. Post-v1. */
    COMMAND_BANK_TRANSFER_EXECUTED: 769,
    /**
     * Sale transactions report file available. NOT in v1 — HMAC-signed webhook
     * distinct from transaction events. Re-add in v1.1 if needed.
     *
     * @see references/viva-docs/md/wh-sale-transactions.txt:118
     */
    SALE_TRANSACTIONS: 7936,
    /** Marketplace-only: a transfer has been made. Post-v1. */
    TRANSFER_CREATED: 8448,
};
//# sourceMappingURL=webhook-events.js.map