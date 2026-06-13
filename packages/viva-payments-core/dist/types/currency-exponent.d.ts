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
import type { MinorUnits } from './common.js';
/**
 * Minor-unit exponent for an ISO 4217 numeric currency code.
 * Accepts the code as a string ('978') or number (978). Unknown/empty → 2.
 */
export declare function minorUnitExponent(currencyCode: string | number | undefined): number;
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
export declare function majorToMinor(amount: number | string | bigint, currencyCode: string | number | undefined): MinorUnits;
//# sourceMappingURL=currency-exponent.d.ts.map