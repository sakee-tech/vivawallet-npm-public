/**
 * resolveRefundStrategy — pure decision function for refund routing.
 *
 * Given a configured strategy (`auto` | `fast` | `standard`) and a refund
 * context (card scheme + card-present flag), returns a {@link RefundDecision}
 * describing which refund path to take and why. The caller (adapter refund
 * handler) is responsible for executing the chosen path and — when the
 * strategy is `auto` and Fast Refund returns 403 — falling back to standard.
 *
 * This is deliberately a pure function with no I/O so it is trivial to unit
 * test and reuse from any adapter.
 *
 * @see docs/ENDPOINTS.md §4 (Fast vs Standard matrix)
 * @see docs/STATE-MACHINE.md §3.1 (card scheme detection from retrieveTransaction)
 * @see docs/plans/multi-mode-v0.md §8.5a
 * @see references/payment-api.yaml:9268 (eligibility: Visa / MC / Maestro)
 */
export type RefundStrategy = 'auto' | 'fast' | 'standard';
/**
 * Refund context surfaced from the adapter refund handler.
 *
 * Populated from a prior `retrieveTransaction` call (for `cardType`) plus
 * a flag from the originating payment session indicating whether the
 * transaction was card-not-present (e-commerce / Smart Checkout) — which
 * every plugin-initiated payment is.
 */
export interface RefundContext {
    /**
     * `cardType` field from {@link RetrieveTransactionResponse}. Viva returns
     * PascalCase scheme names: `'Visa' | 'MasterCard' | 'Maestro' | 'Amex' | ...`.
     * Undefined when Viva omits the field (some non-card payment types).
     *
     * @see docs/STATE-MACHINE.md §3.1
     */
    cardType?: string;
    /**
     * Whether the original transaction was card-not-present (e-commerce).
     * For plugin-initiated payments via Smart Checkout this is always `true`.
     * Kept as an explicit input for future POS / in-store integrations where
     * Fast Refund is not allowed.
     */
    isCardNotPresent: boolean;
}
/**
 * Decision returned by {@link resolveRefundStrategy}.
 *
 * `kind` selects the path; `reason` is a stable, machine-readable explanation
 * suitable for structured logging and observability dashboards. The set of
 * reason strings is a closed enum — extend only with explicit plan review.
 */
export type RefundDecision = {
    kind: 'fast';
    reason: 'configured' | 'auto-eligible';
} | {
    kind: 'standard';
    reason: 'configured' | 'auto-ineligible-scheme' | 'auto-ineligible-card-present' | 'auto-no-card-info';
};
/**
 * Pure decision function. Does not perform any I/O.
 *
 * Behaviour:
 *   - `strategy === 'fast'`     → always `{ kind: 'fast', reason: 'configured' }`.
 *     Caller has explicitly opted in; eligibility is enforced server-side.
 *   - `strategy === 'standard'` → always `{ kind: 'standard', reason: 'configured' }`.
 *   - `strategy === 'auto'`     → decided from {@link RefundContext}:
 *       - card-present              → standard (`auto-ineligible-card-present`)
 *       - undefined cardType        → standard (`auto-no-card-info`)
 *       - eligible scheme + CNP     → fast    (`auto-eligible`)
 *       - non-eligible scheme + CNP → standard (`auto-ineligible-scheme`)
 *
 * On Fast Refund 403 the caller should still fall back to standard refund —
 * this function only handles the pre-call decision, not server-side rejection.
 *
 * @see docs/ENDPOINTS.md §4
 * @see references/payment-api.yaml:9268
 */
export declare function resolveRefundStrategy(strategy: RefundStrategy, ctx: RefundContext): RefundDecision;
//# sourceMappingURL=strategy.d.ts.map