/**
 * cancel-guard.ts — the single source of truth for "is this payment in a
 * terminal viva_transaction state that forbids cancellation?".
 *
 * This predicate is shared by BOTH cancel layers:
 *   - the Shop-API resolver pre-guard (shop-api.resolver.ts, Step 6), and
 *   - the payment-method handler (payment-method-handler.ts, cancelPayment).
 *
 * They MUST agree. When the carve-out lived only in the handler, the resolver's
 * own row-level guard refused first and short-circuited before the handler ever
 * ran — so the handler's reconcile was dead code for exactly the state it was
 * written to fix (#26 regression in 0.3.2). Centralising the decision here makes
 * that drift impossible: change the rule once, both layers move together.
 */
/** viva_transaction statuses that normally forbid a cancel. */
export declare const TERMINAL_STATUSES: Set<string>;
/**
 * Whether a cancel must be refused outright at the row-status layer.
 *
 * Returns `false` (i.e. DO NOT refuse — let the handler reconcile) for the #26
 * captured/unsettled desync: a row marked `captured` whose Vendure Payment never
 * reached `Settled`. That pairing is contradictory — a genuinely captured
 * payment would be `Settled` — so it is not a true terminal state. Refusing it
 * strands the `Created` payment, which keeps counting in
 * `totalCoveredByPayments()`, drops the retry's amount-due to 0, and bricks
 * `createPayment` on `isvAmountTooHigh(_, 0)` with no recovery path. Instead we
 * fall through to the handler, which re-verifies the transaction with Viva and
 * either settles the payment (genuine capture → order completes) or frees it
 * (row was mis-marked → retry unblocked).
 *
 * Every other terminal status (refunded / failed / cancelled / a genuinely
 * settled capture) is still refused.
 *
 * @param rowStatus   viva_transaction.status, or undefined when no row exists.
 * @param paymentState the Vendure Payment.state (e.g. 'Created', 'Settled').
 */
export declare function shouldRefuseCancel(rowStatus: string | undefined, paymentState: string): boolean;
//# sourceMappingURL=cancel-guard.d.ts.map