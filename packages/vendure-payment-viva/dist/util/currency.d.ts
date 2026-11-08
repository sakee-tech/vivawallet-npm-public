/**
 * currency.ts — ISO 4217 alpha ↔ numeric conversion helpers.
 *
 * Viva's API requires numeric currency codes (e.g. 826 for GBP).
 * Vendure stores alpha codes (e.g. 'GBP').
 *
 * @see references/viva-docs/md/wh-transaction-payment-created.txt:487
 * @see docs/plans/vendure-plugin-v0.md §"Constraints" (Currency: Numeric ISO 4217)
 */
import type { CurrencyCode } from '@sakeetech/viva-payments-core/types';
/**
 * Convert ISO 4217 alpha code to branded numeric CurrencyCode.
 * Throws if the alpha code is unknown.
 *
 * @example alphaToNumeric('GBP') // → '826' (branded CurrencyCode)
 */
export declare function alphaToNumeric(alpha: string): CurrencyCode;
/**
 * Convert ISO 4217 numeric string to alpha code.
 * Coerces numeric input (string or number) defensively.
 * Throws if the numeric code is unknown.
 *
 * @example numericToAlpha('826') // → 'GBP'
 * @example numericToAlpha(826) // → 'GBP'
 */
export declare function numericToAlpha(numeric: string | number): string;
/**
 * Coerce a webhook payload currency value (may be string or number) to the
 * branded CurrencyCode type.  Throws on unknown code.
 */
export declare function coerceCurrencyCode(raw: string | number): CurrencyCode;
//# sourceMappingURL=currency.d.ts.map