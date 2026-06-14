"use strict";
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
Object.defineProperty(exports, "__esModule", { value: true });
exports.mapStatusLetter = mapStatusLetter;
exports.validateStatusTransition = validateStatusTransition;
exports.applyStatusTransition = applyStatusTransition;
/**
 * Pure mapping from Viva's `StatusId` letter to the plugin's canonical status.
 *
 * M-family letters (M, MA, MI, ML, MS, MW) all map to `'disputed'` with the
 * specific letter preserved as `claimSubstate`.
 *
 * @see references/viva-docs/md/wh-sale-transactions.txt:210
 * @see references/viva-docs/md/wh-transaction-payment-created.txt:398
 */
function mapStatusLetter(letter) {
    switch (letter) {
        case 'F':
            return { status: 'captured', claimSubstate: null };
        case 'A':
            return { status: 'authorized', claimSubstate: null };
        case 'C':
            return { status: 'captured', claimSubstate: null };
        case 'E':
            return { status: 'failed', claimSubstate: null };
        case 'R':
            return { status: 'refunded', claimSubstate: null };
        case 'X':
            return { status: 'cancelled', claimSubstate: null };
        case 'M':
            return { status: 'disputed', claimSubstate: 'M' };
        case 'MA':
            return { status: 'disputed', claimSubstate: 'MA' };
        case 'MI':
            return { status: 'disputed', claimSubstate: 'MI' };
        case 'ML':
            return { status: 'disputed', claimSubstate: 'ML' };
        case 'MS':
            return { status: 'disputed', claimSubstate: 'MS' };
        case 'MW':
            return { status: 'disputed', claimSubstate: 'MW' };
    }
}
// ---------------------------------------------------------------------------
// Status transition lattice
// ---------------------------------------------------------------------------
/**
 * Terminal states — no transitions out (other than idempotent self-transition).
 *
 * Derived from the lattice: any state whose allowed-set is empty.
 * `captured` and `refunded` are NOT terminal because they can still
 * transition to `refunded`/`disputed` respectively.
 *
 * @see Plan P17, Plan A9
 */
const TERMINAL_STATES = new Set([
    'failed',
    'cancelled',
    'disputed',
]);
/**
 * Allowed forward transitions per source state.
 *
 * Lattice (per P17 + A9):
 *   initiated  → authorized | captured | failed
 *   authorized → captured | cancelled | failed | disputed   ← A9 added cancelled
 *   captured   → refunded | disputed
 *   refunded   → disputed
 *   failed     → (terminal — no transitions)
 *   cancelled  → (terminal — no transitions)
 *   disputed   → (terminal — no transitions)
 *
 * Note: `captured` is terminal in the sense that no real-world event takes a
 * captured payment backwards, but it can still transition forward to `refunded`
 * or `disputed`.
 *
 * @see references/viva-docs/md/wh-transaction-payment-created.txt:398
 */
const LATTICE = new Map([
    ['initiated', new Set(['authorized', 'captured', 'failed'])],
    ['authorized', new Set(['captured', 'cancelled', 'failed', 'disputed'])],
    ['captured', new Set(['refunded', 'disputed'])],
    ['refunded', new Set(['disputed'])],
    // Terminal states — empty sets (no forward transitions).
    ['failed', new Set()],
    ['cancelled', new Set()],
    ['disputed', new Set()],
]);
// Verify the lattice is fully specified (TypeScript does not enforce exhaustive
// Map entries, so we do a runtime assertion at module load time).
const _ALL_STATUSES = [
    'initiated',
    'authorized',
    'captured',
    'refunded',
    'failed',
    'cancelled',
    'disputed',
];
for (const s of _ALL_STATUSES) {
    if (!LATTICE.has(s)) {
        throw new Error(`BUG: status-lattice.ts is missing an entry for status '${s}'`);
    }
}
// ---------------------------------------------------------------------------
// Backward-reachability: used to classify BACKWARD vs ILLEGAL
// ---------------------------------------------------------------------------
/**
 * Build the set of all states that are ancestors (upstream) of `target` in the
 * DAG. Used to classify a rejected transition as BACKWARD vs ILLEGAL.
 *
 * The disputed state is a "side-exit" reachable from multiple states; we walk
 * the full DAG regardless.
 */
function computeAncestors(target) {
    const ancestors = new Set();
    const queue = [];
    // Find direct parents of `target`.
    for (const [from, allowed] of LATTICE) {
        if (allowed.has(target)) {
            queue.push(from);
        }
    }
    while (queue.length > 0) {
        const node = queue.shift();
        if (ancestors.has(node))
            continue;
        ancestors.add(node);
        // Walk further up.
        for (const [from, allowed] of LATTICE) {
            if (allowed.has(node) && !ancestors.has(from)) {
                queue.push(from);
            }
        }
    }
    return ancestors;
}
// Pre-compute ancestor sets for all statuses (module-load-time, not per-call).
const _ANCESTORS = new Map(_ALL_STATUSES.map((s) => [s, computeAncestors(s)]));
// ---------------------------------------------------------------------------
// Public validator
// ---------------------------------------------------------------------------
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
function validateStatusTransition(current, next) {
    // Idempotent re-apply: same → same is always OK.
    if (current === next) {
        return { ok: true, next };
    }
    const allowed = LATTICE.get(current);
    // Terminal state: current has no allowed transitions.
    if (TERMINAL_STATES.has(current) && (allowed === undefined || allowed.size === 0)) {
        return { ok: false, reason: 'TERMINAL', current, attempted: next };
    }
    // Allowed forward transition.
    if (allowed !== undefined && allowed.has(next)) {
        return { ok: true, next };
    }
    // Check if `next` is an ancestor of `current` → BACKWARD.
    const ancestors = _ANCESTORS.get(current);
    if (ancestors !== undefined && ancestors.has(next)) {
        return { ok: false, reason: 'BACKWARD', current, attempted: next };
    }
    // Anything else (cross-edge, unrelated state) → ILLEGAL.
    return { ok: false, reason: 'ILLEGAL', current, attempted: next };
}
/**
 * Convenience wrapper: looks up `mapStatusLetter` then calls
 * `validateStatusTransition`. Returns the full result so callers can decide
 * whether to apply or log.
 *
 * Not part of the core interface spec, provided for S8 convenience.
 */
function applyStatusTransition(current, incomingLetter) {
    const { status: next, claimSubstate } = mapStatusLetter(incomingLetter);
    const result = validateStatusTransition(current, next);
    return { ...result, claimSubstate };
}
//# sourceMappingURL=status-lattice.js.map