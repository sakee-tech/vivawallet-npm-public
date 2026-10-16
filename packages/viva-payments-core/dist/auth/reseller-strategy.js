"use strict";
/**
 * Reseller basic-auth strategy for ISV endpoints that require it.
 *
 * Some ISV API calls (e.g. `cancelOrder`) require a Reseller-level basic-auth
 * credential rather than the OAuth2 bearer token. This strategy computes the
 * `Authorization: Basic <base64(resellerId:merchantId:resellerApiKey)>` header
 * value and returns it from `getBearerToken()` so the S3 HTTP client remains
 * uniform — it always calls `getBearerToken()` and uses the result verbatim.
 *
 * Credential combination used (three-part):
 *   Username = resellerId:merchantId, Password = resellerApiKey
 *
 * @see docs/internal/payment-isv-api.yaml:2650 (reseller auth structure)
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.ResellerBasicAuthStrategy = void 0;
/**
 * Returns a Basic-auth Authorization header value for ISV reseller calls.
 *
 * `getBearerToken()` returns `Basic <base64(resellerId:merchantId:resellerApiKey)>`.
 * The S3 layer sets `Authorization: <value>` — for this strategy the value
 * includes the `Basic ` prefix so it can be used identically to a bearer value.
 *
 * `getAuthorizationHeader()` is exposed as a convenience alias.
 */
class ResellerBasicAuthStrategy {
    name = 'reseller-basic-auth';
    _resellerId;
    _merchantId;
    _resellerApiKey;
    constructor({ resellerId, merchantId, resellerApiKey }) {
        this._resellerId = resellerId;
        this._merchantId = merchantId;
        this._resellerApiKey = resellerApiKey;
    }
    /**
     * Returns the `Authorization` header value.
     *
     * Note: for this strategy the returned string includes the `Basic ` prefix
     * (e.g. `"Basic dXNlcjpwYXNz"`). The S3 client places it verbatim in the
     * Authorization header.  This is intentional — the abstraction is "value to
     * put in Authorization header", not "raw bearer token".
     */
    async getBearerToken(_opts) {
        return this.getAuthorizationHeader();
    }
    /**
     * Returns `Basic <base64(resellerId:merchantId:resellerApiKey)>`.
     *
     * The Viva reseller Basic credential is a THREE-part string: username is
     * `ResellerId:MerchantId`, password is `ResellerApiKey`. resellerId IS part of
     * the credential — it is NOT a query/path parameter (the earlier assumption was
     * wrong). Matches the BasicAuthClient reseller variant.
     * @see docs/internal/payment-isv-api.yaml:2650 (reseller auth structure)
     */
    getAuthorizationHeader() {
        const encoded = Buffer.from(`${this._resellerId}:${this._merchantId}:${this._resellerApiKey}`).toString('base64');
        return `Basic ${encoded}`;
    }
    /** Reseller ID accessor for S3 correlation (not part of AuthStrategy). */
    get resellerId() {
        return this._resellerId;
    }
}
exports.ResellerBasicAuthStrategy = ResellerBasicAuthStrategy;
//# sourceMappingURL=reseller-strategy.js.map