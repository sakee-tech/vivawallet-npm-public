"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.CARD_TYPE_BY_ID = void 0;
exports.resolveCardType = resolveCardType;
/**
 * Viva's numeric CardTypeId → string scheme name mapping.
 *
 * Used by `Payments.retrieveTransaction` to populate the normalized
 * `cardType: string` field for downstream consumers (e.g.,
 * {@link import('../refunds/strategy.js').resolveRefundStrategy resolveRefundStrategy}).
 *
 * Mapping source: `references/viva-docs/md/wh-transaction-payment-created.txt`
 * (search for `CardTypeId`). Viva documents the following nine values:
 *
 *   0 = Visa
 *   1 = Mastercard
 *   2 = Diners
 *   3 = Amex
 *   4 = Invalid
 *   5 = Unknown
 *   6 = Maestro
 *   7 = Discover
 *   8 = JCB
 *
 * Casing note:
 *   `resolveRefundStrategy` matches the Fast-Refund eligible-scheme set
 *   case-sensitively against the string emitted here. The strategy's set
 *   uses `'MasterCard'` (camelCase). We emit `'MasterCard'` for cardTypeId
 *   `1` to match — this is the only difference from the doc's raw casing.
 *   Diners is emitted as the doc's `'Diners'` (no "Club") so future
 *   eligibility additions key off a single canonical string.
 *
 *   The sentinel categories `Invalid` (4) and `Unknown` (5) are intentionally
 *   NOT exposed as scheme strings — they indicate "no useful card info" and
 *   `resolveCardType` returns `undefined` for them so the auto-refund
 *   decision falls through to `auto-no-card-info`.
 *
 * @see references/viva-docs/md/wh-transaction-payment-created.txt — search "CardTypeId"
 * @see ../refunds/strategy.ts (FAST_REFUND_ELIGIBLE_SCHEMES)
 * @see docs/STATE-MACHINE.md §3.1
 */
exports.CARD_TYPE_BY_ID = Object.freeze({
    0: 'Visa',
    1: 'MasterCard',
    2: 'Diners',
    3: 'Amex',
    // 4 = Invalid  → intentionally omitted (sentinel, not a scheme)
    // 5 = Unknown  → intentionally omitted (sentinel, not a scheme)
    6: 'Maestro',
    7: 'Discover',
    8: 'JCB',
});
/**
 * Pure helper — returns the string scheme name for a Viva numeric cardTypeId,
 * or `undefined` if the id is null/undefined, a known sentinel (Invalid /
 * Unknown), or not present in the documented mapping.
 *
 * Pure, no I/O. Safe to call from anywhere — including refund strategy
 * decisions and tests.
 */
function resolveCardType(cardTypeId) {
    if (cardTypeId == null)
        return undefined;
    return exports.CARD_TYPE_BY_ID[cardTypeId];
}
//# sourceMappingURL=card-types.js.map