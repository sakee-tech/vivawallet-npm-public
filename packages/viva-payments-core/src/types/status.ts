/**
 * Viva transaction status letter mapping and plugin status enum.
 *
 * Implements plan P17: maps Viva's raw `StatusId` letter codes to the
 * plugin's canonical `VivaTransactionStatus` enum. The M-family letters
 * (M, MA, MI, ML, MS, MW) all map to `'disputed'` with the specific
 * letter stored in `claim_substate`.
 *
 * Implements plan A9: adds `authorized → cancelled` transition
 * (void-before-capture).
 *
 * The actual runtime `mapStatusLetter` function lives in S4
 * (src/webhooks/status-lattice.ts). This file is types only.
 *
 * @see references/viva-docs/md/wh-transaction-payment-created.txt:398
 * @see references/viva-docs/md/wh-sale-transactions.txt:210
 */

// ---------------------------------------------------------------------------
// Status letters
// ---------------------------------------------------------------------------

/**
 * Viva `StatusId` string values as documented.
 *
 * Single-letter values:
 *   F = Finished (captured/completed)
 *   A = Active (authorized, awaiting capture)
 *   C = Captured
 *   E = Error (failed)
 *   R = Refunded
 *   X = Cancelled
 *
 * Claim/dispute multi-letter values:
 *   M   = Claimed
 *   MA  = Claim Awaiting Response
 *   MI  = Claim In Progress
 *   ML  = Claim Lost
 *   MS  = Suspected Claimed
 *   MW  = Claim Won
 *
 * @see references/viva-docs/md/wh-transaction-payment-created.txt:398
 */
export type VivaStatusLetter =
  | 'F'
  | 'A'
  | 'C'
  | 'E'
  | 'R'
  | 'X'
  | 'M'
  | 'MA'
  | 'MI'
  | 'ML'
  | 'MS'
  | 'MW';

// ---------------------------------------------------------------------------
// Plugin canonical status
// ---------------------------------------------------------------------------

/**
 * Plugin canonical transaction status enum.
 *
 * This is what viva_transaction.status stores in the database.
 * Defined as string literals for direct SQL/JSON compatibility.
 *
 * Monotonic lattice (plan A9):
 *   initiated → authorized → captured → refunded   (terminal)
 *                          → cancelled             (terminal)
 *                          → disputed +substate    (terminal from captured)
 *            → failed                              (terminal)
 *   authorized → cancelled                         (void-before-capture)
 *
 * @see references/viva-docs/md/wh-transaction-payment-created.txt:398
 */
export type VivaTransactionStatus =
  | 'initiated'
  | 'authorized'
  | 'captured'
  | 'refunded'
  | 'cancelled'
  | 'failed'
  | 'disputed';

/**
 * The claim sub-states for disputed transactions.
 * Stored in viva_transaction.claim_substate when status = 'disputed'.
 *
 * @see references/viva-docs/md/wh-transaction-payment-created.txt:411
 */
export type VivaClaimSubstate = 'M' | 'MA' | 'MI' | 'ML' | 'MS' | 'MW';

// ---------------------------------------------------------------------------
// Status mapping (type-level reference)
// ---------------------------------------------------------------------------

/**
 * Type-level mapping from VivaStatusLetter to VivaTransactionStatus.
 * Used as documentation and compile-time reference for S4 implementors.
 *
 * Runtime function `mapStatusLetter(letter) → VivaTransactionStatus` lives in:
 *   packages/viva-payments-core/src/webhooks/status-lattice.ts
 *
 * @see references/viva-docs/md/wh-transaction-payment-created.txt:398
 */
export type StatusLetterToTransactionStatus = {
  readonly F: 'captured';
  readonly A: 'authorized';
  readonly C: 'captured';
  readonly E: 'failed';
  readonly R: 'refunded';
  readonly X: 'cancelled';
  readonly M: 'disputed';
  readonly MA: 'disputed';
  readonly MI: 'disputed';
  readonly ML: 'disputed';
  readonly MS: 'disputed';
  readonly MW: 'disputed';
};

/**
 * Status letters that map to the `'disputed'` plugin status.
 * The specific letter MUST be preserved in `claim_substate`.
 *
 * @see references/viva-docs/md/wh-transaction-payment-created.txt:411
 */
export type ClaimStatusLetter = 'M' | 'MA' | 'MI' | 'ML' | 'MS' | 'MW';

/**
 * Terminal statuses — once reached, no further transitions are allowed.
 * The monotonic lattice in status-lattice.ts enforces this invariant.
 *
 * @see Plan P17, Plan A9
 */
export type TerminalVivaTransactionStatus = 'captured' | 'refunded' | 'cancelled' | 'failed' | 'disputed';

/**
 * Non-terminal statuses — transitions out of these are allowed.
 */
export type NonTerminalVivaTransactionStatus = Exclude<VivaTransactionStatus, TerminalVivaTransactionStatus>;

/**
 * A status transition — from a non-terminal state to any target state.
 * The status-lattice runtime validates this against the allowed lattice.
 */
export interface StatusTransition {
  readonly from: VivaTransactionStatus;
  readonly to: VivaTransactionStatus;
}

/**
 * Result of applying a status letter to the current lattice state.
 * If `allowed` is false, the transition is a no-op and should be logged
 * as a warning (backwards transition attempt).
 */
export type StatusTransitionResult =
  | { readonly allowed: true; readonly nextStatus: VivaTransactionStatus; readonly claimSubstate?: VivaClaimSubstate }
  | { readonly allowed: false; readonly reason: string };
