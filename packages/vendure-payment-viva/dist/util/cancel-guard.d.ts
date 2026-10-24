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
/**
 * What to do with a cancel request, decided purely from the Vendure
 * `Payment.state`:
 *
 *  - `proceed`       — `Created` / `Authorized`: cancellable. Void the Viva order
 *                      and transition the Payment to `Cancelled`.
 *  - `refuse-paid`   — `Settled`: the money was taken. Not cancellable; the
 *                      operator must issue a refund instead.
 *  - `already-done`  — `Cancelled` / `Declined` / `Error`: terminal AND
 *                      non-counting, so the order is already retryable. Treat a
 *                      repeat cancel as an idempotent success, never an error
 *                      (this is what makes the storefront's concurrent
 *                      cancel-return renders safe — the loser of the race lands
 *                      here and still gets its Order back). #27.
 */
export type CancelDisposition = 'proceed' | 'refuse-paid' | 'already-done';
/**
 * Classify a cancel request from the authoritative Vendure `Payment.state`.
 *
 * @param paymentState the Vendure `Payment.state` (e.g. 'Created', 'Settled').
 */
export declare function classifyCancel(paymentState: string): CancelDisposition;
//# sourceMappingURL=cancel-guard.d.ts.map