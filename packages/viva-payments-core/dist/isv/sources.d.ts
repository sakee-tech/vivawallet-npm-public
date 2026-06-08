/**
 * IsvSources — ISV-mode admin operations on payment sources for connected merchants.
 *
 * Wraps `POST /api/sources` on the Viva legacy host using a `BasicAuthClient`
 * configured with `authVariant: 'reseller'`. A "source" is a payment-source
 * configuration on a merchant account — e.g. a Smart Checkout source linked to
 * a domain + success/fail callback paths, or a physical (in-store) source.
 *
 * The reseller credentials baked into the underlying `BasicAuthClient` are
 * scoped to **one** connected merchant per client instance. To operate on
 * multiple merchants under the same reseller account, construct multiple
 * `BasicAuthClient` instances (one per merchant) and pass each to its own
 * `IsvSources`.
 *
 * @see references/payment-isv-api.yaml:135
 * @see docs/AUTH.md §1.2 (Reseller Basic)
 * @see docs/ENDPOINTS.md §5.1
 */
import type { BasicAuthClient } from '../legacy/client.js';
/**
 * Input for `createEcommerceSource` — Smart Checkout source for a website.
 */
export interface CreateEcommerceSourceInput {
    /** Domain the source is bound to, e.g. `www.example.com`. */
    domain: string;
    /** URL path the customer is redirected to after a successful checkout. */
    pathSuccess: string;
    /** URL path the customer is redirected to after a failed checkout. */
    pathFail: string;
    /** Friendly label for the source (optional). */
    name?: string;
    /**
     * 4-digit source code (1000..9999). Auto-assigned by Viva when omitted.
     */
    sourceCode?: number;
    /** Whether the domain is served over HTTPS. Defaults to `true`. */
    isSecure?: boolean;
}
/**
 * Input for `createPhysicalSource` — in-store / terminal source.
 */
export interface CreatePhysicalSourceInput {
    /** Friendly label for the physical source. Required. */
    name: string;
    /** 4-digit source code (1000..9999). Auto-assigned by Viva when omitted. */
    sourceCode?: number;
}
/**
 * Response shape from `POST /api/sources`. Kept permissive — Viva's response
 * may include additional fields depending on the source type / account state.
 */
export interface SourceResponse {
    sourceCode: number;
    name?: string;
    [k: string]: unknown;
}
export declare class IsvSources {
    private readonly basic;
    /**
     * @param basic A `BasicAuthClient` already configured with
     *   `authVariant: 'reseller'`. The reseller credentials are tied to ONE
     *   connected merchant per client instance.
     */
    constructor(basic: BasicAuthClient);
    /**
     * Create a Smart Checkout (ecommerce) payment source for the connected
     * merchant.
     *
     * @see docs/ENDPOINTS.md §5.1
     */
    createEcommerceSource(input: CreateEcommerceSourceInput): Promise<SourceResponse>;
    /**
     * Create a physical (in-store / terminal) payment source for the connected
     * merchant.
     *
     * @see docs/ENDPOINTS.md §5.1
     */
    createPhysicalSource(input: CreatePhysicalSourceInput): Promise<SourceResponse>;
}
//# sourceMappingURL=sources.d.ts.map