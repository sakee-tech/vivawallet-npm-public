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
/**
 * Card schemes eligible for Fast Refund per Viva docs.
 *
 * Matched case-sensitively against `cardType` from `retrieveTransaction`
 * (PascalCase per Viva convention). If Viva ever returns a differently-cased
 * value, the decision falls through to the `auto-ineligible-scheme` branch
 * and the caller routes to standard refund.
 *
 * @see references/payment-api.yaml:9268
 * @see docs/STATE-MACHINE.md §3.1
 */
const FAST_REFUND_ELIGIBLE_SCHEMES = new Set([
    'Visa',
    'MasterCard',
    'Maestro',
]);
// ---------------------------------------------------------------------------
// Decision function
// ---------------------------------------------------------------------------
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
export function resolveRefundStrategy(strategy, ctx) {
    if (strategy === 'fast') {
        return { kind: 'fast', reason: 'configured' };
    }
    if (strategy === 'standard') {
        return { kind: 'standard', reason: 'configured' };
    }
    // auto
    if (!ctx.isCardNotPresent) {
        return { kind: 'standard', reason: 'auto-ineligible-card-present' };
    }
    if (!ctx.cardType) {
        return { kind: 'standard', reason: 'auto-no-card-info' };
    }
    if (FAST_REFUND_ELIGIBLE_SCHEMES.has(ctx.cardType)) {
        return { kind: 'fast', reason: 'auto-eligible' };
    }
    return { kind: 'standard', reason: 'auto-ineligible-scheme' };
}
//# sourceMappingURL=strategy.js.map