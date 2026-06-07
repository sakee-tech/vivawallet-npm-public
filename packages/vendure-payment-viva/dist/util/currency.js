/**
 * currency.ts — ISO 4217 alpha ↔ numeric conversion helpers.
 *
 * Viva's API requires numeric currency codes (e.g. 826 for GBP).
 * Vendure stores alpha codes (e.g. 'GBP').
 *
 * @see references/viva-docs/md/wh-transaction-payment-created.txt:487
 * @see docs/plans/vendure-plugin-v0.md §"Constraints" (Currency: Numeric ISO 4217)
 */
import { asCurrencyCode } from '@sakeetech/viva-payments-core/types';
// ---------------------------------------------------------------------------
// Lookup tables
// ---------------------------------------------------------------------------
/**
 * ISO 4217 alpha → numeric mapping.
 * Extend as new currencies are onboarded.
 */
const ALPHA_TO_NUMERIC = {
    EUR: '978',
    GBP: '826',
    USD: '840',
    PLN: '985',
    RON: '946',
    CZK: '203',
    HUF: '348',
    BGN: '975',
    DKK: '208',
    SEK: '752',
    NOK: '578',
    CHF: '756',
    AUD: '036',
    CAD: '124',
    JPY: '392',
    SGD: '702',
    HKD: '344',
    NZD: '554',
    MXN: '484',
    BRL: '986',
    ZAR: '710',
    TRY: '949',
    ILS: '376',
    AED: '784',
    THB: '764',
};
const NUMERIC_TO_ALPHA = Object.fromEntries(Object.entries(ALPHA_TO_NUMERIC).map(([alpha, numeric]) => [numeric, alpha]));
// ---------------------------------------------------------------------------
// Converters
// ---------------------------------------------------------------------------
/**
 * Convert ISO 4217 alpha code to branded numeric CurrencyCode.
 * Throws if the alpha code is unknown.
 *
 * @example alphaToNumeric('GBP') // → '826' (branded CurrencyCode)
 */
export function alphaToNumeric(alpha) {
    const upper = alpha.toUpperCase();
    const numeric = ALPHA_TO_NUMERIC[upper];
    if (!numeric) {
        throw new Error(`Unknown ISO 4217 alpha currency code: "${alpha}"`);
    }
    return asCurrencyCode(numeric);
}
/**
 * Convert ISO 4217 numeric string to alpha code.
 * Coerces numeric input (string or number) defensively.
 * Throws if the numeric code is unknown.
 *
 * @example numericToAlpha('826') // → 'GBP'
 * @example numericToAlpha(826) // → 'GBP'
 */
export function numericToAlpha(numeric) {
    const key = String(numeric).padStart(3, '0');
    const alpha = NUMERIC_TO_ALPHA[key];
    if (!alpha) {
        throw new Error(`Unknown ISO 4217 numeric currency code: "${numeric}"`);
    }
    return alpha;
}
/**
 * Coerce a webhook payload currency value (may be string or number) to the
 * branded CurrencyCode type.  Throws on unknown code.
 */
export function coerceCurrencyCode(raw) {
    const key = String(raw).padStart(3, '0');
    if (!NUMERIC_TO_ALPHA[key]) {
        throw new Error(`Unknown ISO 4217 numeric currency code: "${raw}"`);
    }
    return asCurrencyCode(key);
}
//# sourceMappingURL=currency.js.map