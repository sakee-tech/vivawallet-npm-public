/**
 * Common primitives shared across the Viva Wallet ISV API surface.
 *
 * Covers: currency branding, money representation, ID aliases,
 * environment enumeration, and pagination helpers.
 *
 * @see references/viva-docs/md/wh-transaction-payment-created.txt:487
 * @see references/viva-docs/md/webhooks-for-payments.txt:383
 * @see references/viva-docs/md/oauth2-authentication.txt:145
 */

// ---------------------------------------------------------------------------
// Currency
// ---------------------------------------------------------------------------

/**
 * ISO 4217 numeric currency code, represented as a three-digit string.
 * Examples: '978' for EUR, '826' for GBP, '840' for USD.
 *
 * Branded so it cannot be confused with an arbitrary string.
 *
 * @see references/viva-docs/md/wh-transaction-payment-created.txt:487
 */
export type CurrencyCode = string & { readonly __brand: 'CurrencyCode' };

/**
 * Narrow cast helper — call when you have a validated ISO 4217 numeric string.
 * Runtime validation lives in the implementation layer (S2/S6).
 */
export function asCurrencyCode(code: string): CurrencyCode {
  return code as CurrencyCode;
}

/**
 * Commonly used ISO 4217 numeric currency codes.
 * The map provides ergonomic named constants; the type accepts any 3-digit
 * numeric string so the list is non-exhaustive.
 *
 * @see references/viva-docs/md/wh-transaction-payment-created.txt:487
 */
export const CURRENCY_CODES = {
  EUR: asCurrencyCode('978'),
  GBP: asCurrencyCode('826'),
  USD: asCurrencyCode('840'),
  PLN: asCurrencyCode('985'),
  RON: asCurrencyCode('946'),
  CZK: asCurrencyCode('203'),
  HUF: asCurrencyCode('348'),
  BGN: asCurrencyCode('975'),
  DKK: asCurrencyCode('208'),
  SEK: asCurrencyCode('752'),
  NOK: asCurrencyCode('578'),
} as const satisfies Record<string, CurrencyCode>;

// ---------------------------------------------------------------------------
// Money
// ---------------------------------------------------------------------------

/**
 * Integer minor units (e.g. EUR 12.34 = 1234n).
 *
 * Plan P15 mandates bigint minor units throughout viva-payments-core.
 * Wire format to/from Viva is a JSON integer; convert at the boundary only.
 * NEVER use number for amounts.
 */
export type MinorUnits = bigint;

/**
 * A typed money value combining minor-unit amount with its currency.
 */
export interface Money {
  /** Integer minor units. E.g. 1234n for EUR 12.34. */
  readonly amount: MinorUnits;
  /** ISO 4217 numeric currency code. */
  readonly currency: CurrencyCode;
}

// ---------------------------------------------------------------------------
// ID aliases
// ---------------------------------------------------------------------------

/**
 * UUID string representing a Viva Merchant ID.
 *
 * @see references/viva-docs/md/wh-transaction-payment-created.txt:175
 */
export type MerchantId = string & { readonly __brand: 'MerchantId' };

/**
 * UUID string representing a Viva Connected Account ID.
 * Used for ISV and Marketplace onboarding.
 *
 * @see references/viva-docs/md/wh-account-connected.txt:153
 */
export type ConnectedAccountId = string & { readonly __brand: 'ConnectedAccountId' };

/**
 * UUID string representing a Viva Transaction ID.
 *
 * @see references/viva-docs/md/wh-transaction-payment-created.txt:193
 */
export type TransactionId = string & { readonly __brand: 'TransactionId' };

/**
 * Long integer (bigint in TS) representing a Viva Order Code.
 * Viva uses int64 for order codes; docs show values like 2271655739472609.
 * Stored as bigint to avoid loss of precision beyond Number.MAX_SAFE_INTEGER.
 *
 * @see references/viva-docs/md/wh-transaction-payment-created.txt:176
 */
export type OrderCode = bigint;

// ---------------------------------------------------------------------------
// Environment
// ---------------------------------------------------------------------------

/**
 * Viva Wallet API environment selector.
 *
 * - `demo`       → https://demo-accounts.vivapayments.com (auth)
 *                  https://demo-api.vivapayments.com (API)
 * - `production` → https://accounts.vivapayments.com (auth)
 *                  https://api.vivapayments.com (API)
 *
 * @see references/viva-docs/md/oauth2-authentication.txt:145
 */
export type VivaEnvironment = 'demo' | 'production';

/**
 * Base URLs for each environment.
 *
 * @see references/viva-docs/md/oauth2-authentication.txt:145
 */
export interface VivaEnvironmentUrls {
  readonly authBaseUrl: string;
  readonly apiBaseUrl: string;
}

/**
 * Well-known base URLs keyed by environment.
 *
 * @see references/viva-docs/md/oauth2-authentication.txt:145
 */
export const ENVIRONMENT_URLS: Record<VivaEnvironment, VivaEnvironmentUrls> = {
  demo: {
    authBaseUrl: 'https://demo-accounts.vivapayments.com',
    apiBaseUrl: 'https://demo-api.vivapayments.com',
  },
  production: {
    authBaseUrl: 'https://accounts.vivapayments.com',
    apiBaseUrl: 'https://api.vivapayments.com',
  },
} as const;

/**
 * Legacy host base URLs (Basic auth endpoints).
 *
 * The Viva legacy API lives on `demo.vivapayments.com` / `www.vivapayments.com`.
 * These hosts are used for endpoints that Viva has NOT migrated to the v2/OAuth2
 * surface — specifically `POST /api/transactions/{transactionId}` (refund/cancel-transaction).
 *
 * Verified against Viva sandbox 2026-04-25 (probe scripts):
 * - `POST /checkout/v2/transactions/{id}` (v2/OAuth2) → 405 Method Not Allowed.
 * - `POST /api/transactions/{id}` (legacy/Basic) → 200 with PascalCase response.
 *
 * @see references/viva-docs/md/tut-create-recurring-payment.txt:288
 */
export const LEGACY_HOST: Record<VivaEnvironment, string> = {
  demo: 'https://demo.vivapayments.com',
  production: 'https://www.vivapayments.com',
} as const;

// ---------------------------------------------------------------------------
// Pagination
// ---------------------------------------------------------------------------

/**
 * Generic page-based pagination wrapper used by data-service list endpoints.
 *
 * @see references/viva-docs/md/account-api.txt:1069
 */
export interface PaginatedResponse<T> {
  readonly currentPage: number;
  readonly pageSize: number;
  readonly totalPages: number;
  readonly totalDataCount: number;
  readonly data: readonly T[];
  readonly links: PaginationLinks;
}

/**
 * Navigation links returned alongside paginated results.
 *
 * @see references/viva-docs/md/account-api.txt:1183
 */
export interface PaginationLinks {
  readonly self: string;
  readonly next?: string;
  readonly previous?: string;
}
