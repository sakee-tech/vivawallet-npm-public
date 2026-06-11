/**
 * Viva transaction status mapping and monotonic status lattice.
 *
 * Implements plan P17 (status letter → plugin enum) and plan A9
 * (authorized → cancelled allowed — void-before-capture transition).
 *
 * Status lattice (per P17 + A9):
 *   initiated  → authorized | captured | failed
 *   authorized → captured | cancelled | failed | disputed   ← A9 added cancelled
 *   captured   → refunded | disputed
 *   refunded   → disputed
 *   failed, cancelled, disputed → TERMINAL (no further transitions)
 *
 * Terminal states never transition except to themselves (idempotent re-apply).
 *
 * @see references/viva-docs/md/wh-sale-transactions.txt:210
 * @see references/viva-docs/md/wh-transaction-payment-created.txt:398
 */
import type { VivaStatusLetter, VivaTransactionStatus, VivaClaimSubstate } from '../types/status.js';
/**
 * Pure mapping from Viva's `StatusId` letter to the plugin's canonical status.
 *
 * M-family letters (M, MA, MI, ML, MS, MW) all map to `'disputed'` with the
 * specific letter preserved as `claimSubstate`.
 *
 * @see references/viva-docs/md/wh-sale-transactions.txt:210
 * @see references/viva-docs/md/wh-transaction-payment-created.txt:398
 */
export declare function mapStatusLetter(letter: VivaStatusLetter): {
    status: VivaTransactionStatus;
    claimSubstate: VivaClaimSubstate | null;
};
export type StatusTransitionResult = {
    ok: true;
    next: VivaTransactionStatus;
} | {
    ok: false;
    reason: 'TERMINAL' | 'BACKWARD' | 'ILLEGAL';
    current: VivaTransactionStatus;
    attempted: VivaTransactionStatus;
};
/**
 * Pure validator. Does NOT mutate state. Returns a typed result describing
 * whether the `current → next` transition is allowed by the lattice.
 *
 * Returns:
 * - `{ ok: true, next }` if the transition is allowed OR if `next === current`
 *   (idempotent re-apply).
 * - `{ ok: false, reason: 'TERMINAL' }` if `current` is terminal and
 *   `next !== current`.
 * - `{ ok: false, reason: 'BACKWARD' }` if `next` is an ancestor of `current`
 *   in the DAG.
 * - `{ ok: false, reason: 'ILLEGAL' }` for any other invalid pair.
 *
 * Callers (the Medusa subscriber) use this before issuing an UPDATE to
 * `viva_transaction.status`.
 *
 * @see Plan P17 (status lattice), Plan A9 (authorized → cancelled)
 * @see references/viva-docs/md/wh-transaction-payment-created.txt:398
 */
export declare function validateStatusTransition(current: VivaTransactionStatus, next: VivaTransactionStatus): StatusTransitionResult;
/**
 * Convenience wrapper: looks up `mapStatusLetter` then calls
 * `validateStatusTransition`. Returns the full result so callers can decide
 * whether to apply or log.
 *
 * Not part of the core interface spec, provided for S8 convenience.
 */
export declare function applyStatusTransition(current: VivaTransactionStatus, incomingLetter: VivaStatusLetter): StatusTransitionResult & {
    claimSubstate: VivaClaimSubstate | null;
};
//# sourceMappingURL=status-lattice.d.ts.map