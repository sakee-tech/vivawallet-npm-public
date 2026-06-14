"use strict";
/**
 * cancel-guard.ts — the single source of truth for "can this payment still be
 * cancelled?", keyed on the AUTHORITATIVE Vendure `Payment.state`.
 *
 * Why payment-state and not the viva_transaction row status:
 *   The `viva_transaction` row is an audit/correlation record. It is written by
 *   several independent paths (createPayment, settlePayment, the webhook worker,
 *   cancelPayment) and can legitimately diverge from the Vendure `Payment` — e.g.
 *   a settle webhook stamps the row `captured` (#26) or a half-applied cancel
 *   stamps it `cancelled` (#27) while the Vendure `Payment` is still `Created`.
 *   Earlier guards keyed off the ROW status and so refused forever once the two
 *   diverged, even though the `Created` Payment was exactly what needed
 *   cancelling — bricking every retry on `isvAmountTooHigh(_, 0)` with no escape.
 *
 *   The Vendure `Payment.state` is the only authority that governs whether the
 *   amount still counts in `totalCoveredByPayments()`, so it is the only correct
 *   thing to gate cancellation on. The row never blocks a cancellable Payment.
 *
 * Shared by BOTH cancel layers so they cannot drift:
 *   - the Shop-API resolver pre-guard (shop-api.resolver.ts), and
 *   - the payment-method handler (payment-method-handler.ts, cancelPayment).
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.classifyCancel = classifyCancel;
/**
 * Vendure `Payment` states from which a cancel can still run. Both are
 * "counting" states (they count toward `totalCoveredByPayments()`), so a
 * lingering one bricks retries — they MUST stay cancellable regardless of what
 * the viva_transaction row says.
 */
const CANCELLABLE_PAYMENT_STATES = new Set(['Created', 'Authorized']);
/**
 * Classify a cancel request from the authoritative Vendure `Payment.state`.
 *
 * @param paymentState the Vendure `Payment.state` (e.g. 'Created', 'Settled').
 */
function classifyCancel(paymentState) {
    if (CANCELLABLE_PAYMENT_STATES.has(paymentState))
        return 'proceed';
    if (paymentState === 'Settled')
        return 'refuse-paid';
    // Cancelled / Declined / Error — terminal, non-counting, idempotently done.
    return 'already-done';
}
//# sourceMappingURL=cancel-guard.js.map