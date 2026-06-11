/**
 * Reseller basic-auth strategy for ISV endpoints that require it.
 *
 * Some ISV API calls (e.g. `cancelOrder`) require a Reseller-level basic-auth
 * credential rather than the OAuth2 bearer token. This strategy computes the
 * `Authorization: Basic <base64(merchantId:resellerApiKey)>` header value and
 * returns it from `getBearerToken()` so the S3 HTTP client remains uniform —
 * it always calls `getBearerToken()` and uses the result verbatim.
 *
 * Credential combination used:
 *   Username = merchantId, Password = resellerApiKey
 *
 * TODO(impl): verify exact merchantId:resellerApiKey concatenation against
 * live demo. The ISV docs (`payment-isv-api.txt`) confirm Reseller ID +
 * Merchant ID + Reseller API Key are required credentials but the precise
 * Basic-auth encoding (which field is "username" vs "password") should be
 * validated against a live Viva demo response before shipping.
 * @see references/viva-docs/md/payment-isv-api.txt:1
 */

import type { AuthStrategy } from '../types/auth.js';

export interface ResellerStrategyOptions {
  /** ISV Partner Reseller ID provided by Viva. */
  resellerId: string;
  /** Target merchant's Merchant ID. */
  merchantId: string;
  /** ISV Partner Reseller API Key provided by Viva. */
  resellerApiKey: string;
}

/**
 * Returns a Basic-auth Authorization header value for ISV reseller calls.
 *
 * `getBearerToken()` returns `Basic <base64(merchantId:resellerApiKey)>`.
 * The S3 layer sets `Authorization: <value>` — for this strategy the value
 * includes the `Basic ` prefix so it can be used identically to a bearer value.
 *
 * `getAuthorizationHeader()` is exposed as a convenience alias.
 */
export class ResellerBasicAuthStrategy implements AuthStrategy {
  readonly name = 'reseller-basic-auth';

  private readonly _resellerId: string;
  private readonly _merchantId: string;
  private readonly _resellerApiKey: string;

  constructor({ resellerId, merchantId, resellerApiKey }: ResellerStrategyOptions) {
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
  async getBearerToken(_opts?: { forceRefresh?: boolean }): Promise<string> {
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
  getAuthorizationHeader(): string {
    const encoded = Buffer.from(
      `${this._resellerId}:${this._merchantId}:${this._resellerApiKey}`,
    ).toString('base64');
    return `Basic ${encoded}`;
  }

  /** Reseller ID accessor for S3 correlation (not part of AuthStrategy). */
  get resellerId(): string {
    return this._resellerId;
  }
}
