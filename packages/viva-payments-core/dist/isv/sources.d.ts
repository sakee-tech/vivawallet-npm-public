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
 *
 * `sourceCode` is **required** because Viva's `POST /api/sources` returns HTTP
 * 200 with **no body** (payment-isv-api.yaml:279-284). The caller must supply
 * the 4-digit code they want registered; it cannot be read from the response.
 * Supplying an already-registered code returns 409 (documented idempotent
 * behaviour) making retries safe.
 */
export interface CreateEcommerceSourceInput {
    /** Domain the source is bound to, e.g. `www.example.com`. */
    domain: string;
    /** URL path the customer is redirected to after a successful checkout. */
    pathSuccess: string;
    /** URL path the customer is redirected to after a failed checkout. */
    pathFail: string;
    /**
     * Friendly label for the source. **Required** — Viva's `new_source` schema
     * marks `name` required (payment-isv-api.yaml:7266); omitting it returns 400.
     */
    name: string;
    /**
     * 4-digit source code (1000..9999) as a **string** — Viva's `new_source`
     * schema types `sourceCode` as `string` (payment-isv-api.yaml:7298-7301;
     * Viva support confirmed 2026-06-13: always send quoted, e.g. `"1234"`).
     * **Required** — Viva's response carries no body so the code cannot be
     * recovered after the call. Supply a code you control; duplicate submissions
     * return 409 (idempotent).
     */
    sourceCode: string;
    /** Whether the domain is served over HTTPS. Defaults to `true`. */
    isSecure?: boolean;
}
/**
 * Input for `createPhysicalSource` — in-store / terminal source.
 *
 * `sourceCode` is **required** for the same reason as `CreateEcommerceSourceInput`:
 * Viva returns an empty 200 body and the code cannot be recovered from the response.
 */
export interface CreatePhysicalSourceInput {
    /** Friendly label for the physical source. Required. */
    name: string;
    /**
     * 4-digit source code (1000..9999) as a **string**. **Required** — see
     * `CreateEcommerceSourceInput.sourceCode`.
     */
    sourceCode: string;
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
     * Viva's `POST /api/sources` returns HTTP 200 with **no body**
     * (payment-isv-api.yaml:279-284). The caller must supply `sourceCode` in
     * the request; it cannot be recovered from the response. Returns `void` on
     * success; throws `VivaApiError` on 4xx/5xx.
     *
     * Idempotent: re-submitting the same `sourceCode` returns 409 (safe to retry).
     *
     * @see docs/ENDPOINTS.md §5.1
     */
    createEcommerceSource(input: CreateEcommerceSourceInput): Promise<void>;
    /**
     * Create a physical (in-store / terminal) payment source for the connected
     * merchant.
     *
     * Viva's `POST /api/sources` returns HTTP 200 with **no body**
     * (payment-isv-api.yaml:279-284). Returns `void` on success.
     *
     * Idempotent: re-submitting the same `sourceCode` returns 409 (safe to retry).
     *
     * @see docs/ENDPOINTS.md §5.1
     */
    createPhysicalSource(input: CreatePhysicalSourceInput): Promise<void>;
}
//# sourceMappingURL=sources.d.ts.map