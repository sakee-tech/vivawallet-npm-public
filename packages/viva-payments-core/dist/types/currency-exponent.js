"use strict";
/**
 * ISO 4217 minor-unit exponents + major⇄minor conversion.
 *
 * Viva's API is asymmetric about money:
 *   - REQUEST bodies/queries take amounts in the currency's smallest unit
 *     (minor units / int64) — e.g. £100.37 → 10037.
 *   - RESPONSE bodies return amounts in MAJOR units as a decimal — e.g. the
 *     GET-transaction `Amount` and the legacy refund `Amount` are `0.27`,
 *     `23.17`, `10.55`. (Verified: payment-isv-api.yaml transactions schema
 *     `Amount: type number` example 0.27; delete_transaction `Amount:
 *     format decimal`.)
 *
 * So response amounts MUST be converted major→minor before they can be
 * compared to the minor-unit values we sent. The conversion is exponent-aware:
 * most currencies use 2 decimals (×100), but JPY/KRW use 0 (×1) and
 * BHD/KWD/OMR use 3 (×1000). A blanket ×100 corrupts those.
 *
 * @see references/viva-docs/md/wh-transaction-payment-created.txt:487 (currency code)
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.minorUnitExponent = minorUnitExponent;
exports.majorToMinor = majorToMinor;
/**
 * ISO 4217 numeric codes whose currencies have ZERO minor-unit digits.
 * (The default for everything not listed here or in {@link THREE_DECIMAL} is 2.)
 */
const ZERO_DECIMAL = new Set([
    '108', // BIF
    '152', // CLP
    '174', // KMF
    '262', // DJF
    '324', // GNF
    '352', // ISK
    '392', // JPY
    '410', // KRW
    '548', // VUV
    '600', // PYG
    '646', // RWF
    '704', // VND
    '800', // UGX
    '950', // XAF
    '952', // XOF
    '953', // XPF
]);
/** ISO 4217 numeric codes whose currencies have THREE minor-unit digits. */
const THREE_DECIMAL = new Set([
    '048', // BHD
    '368', // IQD
    '400', // JOD
    '414', // KWD
    '434', // LYD
    '512', // OMR
    '788', // TND
]);
/**
 * Minor-unit exponent for an ISO 4217 numeric currency code.
 * Accepts the code as a string ('978') or number (978). Unknown/empty → 2.
 */
function minorUnitExponent(currencyCode) {
    if (currencyCode === undefined)
        return 2;
    // Normalise to a zero-padded 3-digit string ('978', '48' → '048').
    const code = String(currencyCode).trim().padStart(3, '0');
    if (ZERO_DECIMAL.has(code))
        return 0;
    if (THREE_DECIMAL.has(code))
        return 3;
    return 2;
}
/**
 * Convert a Viva response amount (MAJOR units, e.g. `23.17`) into integer
 * minor units (`2317n`), honouring the currency's exponent.
 *
 * Accepts `number` (JSON number from the wire), numeric `string`, or `bigint`
 * (already-minor passthrough is NOT assumed — a bigint is treated as a whole
 * major-unit value and scaled, matching how Viva would emit `5` for `5.00`).
 *
 * Rounding is decimal-safe: `23.17 * 100` is `2316.9999…` in IEEE-754, so we
 * round after scaling rather than truncating (which is exactly the
 * `BigInt(23.17)` RangeError this replaces).
 *
 * @throws never — non-finite input coerces to `0n`.
 */
function majorToMinor(amount, currencyCode) {
    const exp = minorUnitExponent(currencyCode);
    const factor = 10 ** exp;
    const n = typeof amount === 'bigint' ? Number(amount) : Number(amount);
    if (!Number.isFinite(n))
        return 0n;
    return BigInt(Math.round(n * factor));
}
//# sourceMappingURL=currency-exponent.js.map