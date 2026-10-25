/**
 * Authentication types for the Viva Wallet ISV OAuth 2.0 and reseller
 * basic-auth flows.
 *
 * Implementations live in S2 (packages/viva-payments-core/src/auth/).
 * This file declares interfaces and response shapes only — no runtime code.
 *
 * @see references/viva-docs/md/oauth2-authentication.txt:179
 * @see references/viva-docs/md/isv-credentials.txt:107
 */
/**
 * Raw token response from `POST /connect/token` (client_credentials grant).
 *
 * Each token lasts for 3600 seconds (one hour). The `scope` field reflects
 * the scopes granted to the ISV client application.
 *
 * @see references/viva-docs/md/oauth2-authentication.txt:179
 */
export interface OAuth2TokenResponse {
    /** JWT bearer token. Include as `Authorization: Bearer <access_token>`. */
    readonly access_token: string;
    /** Lifetime in seconds. Typically 3600. */
    readonly expires_in: number;
    /** Always `"Bearer"` for this grant type. */
    readonly token_type: 'Bearer';
    /** Space-delimited scopes granted. */
    readonly scope: string;
}
/**
 * Enriched token value stored in the cache after a successful fetch.
 * `expires_at` is `Date.now() + (expires_in * 1000)` at fetch time.
 */
export interface CachedToken {
    readonly access_token: string;
    /** Unix epoch milliseconds when the token expires. */
    readonly expires_at: number;
    readonly scope: string;
}
/**
 * Credentials for the ISV Reseller basic-auth strategy.
 *
 * Some ISV API calls (e.g. cancelOrder) require Reseller-level credentials
 * rather than the OAuth2 bearer token. These are distinct from the
 * Client ID + Client Secret used for client_credentials.
 *
 * @see references/viva-docs/md/isv-credentials.txt:107
 */
export interface ResellerBasicAuthCredentials {
    /** ISV Partner Reseller ID provided by Viva. */
    readonly resellerId: string;
    /** Target merchant's Merchant ID. */
    readonly merchantId: string;
    /** ISV Partner Reseller API Key provided by Viva. */
    readonly resellerApiKey: string;
}
/**
 * Pluggable authentication strategy interface.
 *
 * Implementations (OAuth2ClientCredentialsStrategy, ResellerBasicAuthStrategy)
 * are defined in S2. The HTTP client accepts an `AuthStrategy` and calls
 * `getBearerToken()` before each outbound request.
 *
 * Single-flight token refresh and caching are implementation concerns;
 * callers only invoke `getBearerToken()`.
 *
 * @see references/viva-docs/md/oauth2-authentication.txt:128
 */
export interface AuthStrategy {
    /**
     * Returns a valid bearer token string (without the `Bearer ` prefix).
     *
     * @param opts.forceRefresh - If true, bypass the cache and fetch a fresh token.
     */
    getBearerToken(opts?: {
        readonly forceRefresh?: boolean;
    }): Promise<string>;
    /** Stable name used in logs and metrics (e.g. `"oauth2"`, `"reseller"`). */
    readonly name: string;
}
//# sourceMappingURL=auth.d.ts.map