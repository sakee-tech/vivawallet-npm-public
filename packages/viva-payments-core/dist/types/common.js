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
/**
 * Narrow cast helper — call when you have a validated ISO 4217 numeric string.
 * Runtime validation lives in the implementation layer (S2/S6).
 */
export function asCurrencyCode(code) {
    return code;
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
};
/**
 * Well-known base URLs keyed by environment.
 *
 * @see references/viva-docs/md/oauth2-authentication.txt:145
 */
export const ENVIRONMENT_URLS = {
    demo: {
        authBaseUrl: 'https://demo-accounts.vivapayments.com',
        apiBaseUrl: 'https://demo-api.vivapayments.com',
    },
    production: {
        authBaseUrl: 'https://accounts.vivapayments.com',
        apiBaseUrl: 'https://api.vivapayments.com',
    },
};
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
export const LEGACY_HOST = {
    demo: 'https://demo.vivapayments.com',
    production: 'https://www.vivapayments.com',
};
//# sourceMappingURL=common.js.map