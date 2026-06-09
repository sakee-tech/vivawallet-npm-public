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
exports.V1_EVENT_TYPE_IDS = exports.EVENT_TYPES = void 0;
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
 *   7936 — Sale Transactions (HMAC-signed, deferred from v1 core but type-guard kept)
 *
 * @see references/viva-docs/md/webhooks-for-payments.txt:141
 */
function isTransactionEvent(id) {
    return id === 1796 || id === 1797 || id === 1798 || id === 4865 || id === 7936;
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
 * All v1-scope event IDs as a frozen array.
 *
 * Used by `viva:register-webhooks` CLI to enumerate the required registrations
 * and by the route handler to reject unknown event types.
 *
 * @see references/viva-docs/md/webhooks-for-payments.txt:141
 */
exports.V1_EVENT_TYPE_IDS = Object.freeze([
    1796, 1797, 1798, 4865, 8193, 8194,
]);
//# sourceMappingURL=event-types.js.map