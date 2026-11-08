"use strict";
/**
 * Runtime helpers for Viva webhook event type IDs.
 *
 * Re-exports EVENT_TYPES and VivaEventTypeId from the types package, and
 * provides runtime type-guard helpers for routing webhook payloads.
 *
 * @see references/viva-docs/md/webhooks-for-payments.txt:141
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.ISV_EVENT_TYPE_IDS = exports.V1_EVENT_TYPE_IDS = exports.EVENT_TYPES = void 0;
exports.isTransactionEvent = isTransactionEvent;
exports.isOnboardingEvent = isOnboardingEvent;
var webhook_events_js_1 = require("../types/webhook-events.js");
Object.defineProperty(exports, "EVENT_TYPES", { enumerable: true, get: function () { return webhook_events_js_1.EVENT_TYPES; } });
/**
 * Returns `true` for event types that carry a transaction payload and require
 * MerchantId-based tenant resolution.
 *
 * v1-scope transaction events:
 *   1796 — Transaction Payment Created
 *   1797 — Transaction Reversal Created
 *   1798 — Transaction Failed
 *   4865 — Order Updated (cancellation)
 *
 * @see references/viva-docs/md/webhooks-for-payments.txt:141
 */
function isTransactionEvent(id) {
    return id === 1796 || id === 1797 || id === 1798 || id === 4865;
}
/**
 * Returns `true` for event types that carry an onboarding payload and require
 * ConnectedAccountId-based tenant resolution.
 *
 * v1-scope onboarding events:
 *   8193 — Account Connected
 *   8194 — Account Verification Status Changed
 *
 * @see references/viva-docs/md/webhooks-for-payments.txt:224
 */
function isOnboardingEvent(id) {
    return id === 8193 || id === 8194;
}
/**
 * All v1-scope event IDs the webhook handler ACCEPTS INBOUND, as a frozen array.
 *
 * This is the route handler's allow-list for incoming notifications — it
 * includes 4865 (Order Updated) because the endpoint legitimately RECEIVES
 * order-cancellation events. It is NOT the set to register via the ISV API:
 * 4865 is not registerable at the ISV partner-account level (see
 * {@link ISV_EVENT_TYPE_IDS}). Use this for inbound validation only.
 *
 * @see references/viva-docs/md/webhooks-for-payments.txt:141
 */
exports.V1_EVENT_TYPE_IDS = Object.freeze([
    1796, 1797, 1798, 4865, 8193, 8194,
]);
/**
 * Event IDs registerable via the ISV webhook API (`POST /isv/v1/webhooks`).
 *
 * The ISV partner-account webhook API accepts only the transaction events plus
 * the two "Marketplace & ISV only" onboarding events. It does NOT accept 4865
 * (Order Updated) — that is an order-level Smart Checkout event registerable
 * only per-merchant via Self-Care, and `POST /isv/v1/webhooks` rejects it with
 * `IsvCreateWebhookFailedInvalidEventTypeId`. (sakee-tech/vivawallet-npm-public#18)
 *
 *   1796 — Transaction Payment Created
 *   1797 — Transaction Reversal Created
 *   1798 — Transaction Failed
 *   8193 — Account Connected            (Marketplace & ISV only)
 *   8194 — Account Verification Status Changed (Marketplace & ISV only)
 *
 * 1799 (Transaction Price Calculated) is intentionally excluded — it is
 * deferred post-v1 (see DEFERRED_EVENT_TYPES).
 *
 * @see references/viva-docs/md/webhooks-for-payments.txt:222 (8193/8194 "Marketplace & ISV only")
 * @see references/viva-docs/md/isv-partner-program.txt:200 (ISV webhook event list — no 4865)
 */
exports.ISV_EVENT_TYPE_IDS = Object.freeze([
    1796, 1797, 1798, 8193, 8194,
]);
//# sourceMappingURL=event-types.js.map