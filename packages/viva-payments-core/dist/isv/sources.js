"use strict";
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
Object.defineProperty(exports, "__esModule", { value: true });
exports.IsvSources = void 0;
const index_js_1 = require("../errors/index.js");
// ---------------------------------------------------------------------------
// Validation helpers
// ---------------------------------------------------------------------------
function requireNonEmptyString(value, field) {
    if (typeof value !== 'string' || value.trim() === '') {
        throw new index_js_1.VivaValidationError({
            message: `IsvSources: ${field} is required and must be a non-empty string`,
        });
    }
}
/**
 * Viva types `sourceCode` as a string but constrains it to a 4-digit code
 * (1000..9999) in the UI/docs. Enforce both: a quoted 4-digit numeric string.
 */
function validateSourceCode(value) {
    // 1000..9999 → first digit 1-9, then three digits.
    if (typeof value !== 'string' || !/^[1-9]\d{3}$/.test(value)) {
        throw new index_js_1.VivaValidationError({
            message: `IsvSources: sourceCode must be a 4-digit numeric string in "1000".."9999", got ${JSON.stringify(value)}`,
        });
    }
}
// ---------------------------------------------------------------------------
// IsvSources
// ---------------------------------------------------------------------------
class IsvSources {
    basic;
    /**
     * @param basic A `BasicAuthClient` already configured with
     *   `authVariant: 'reseller'`. The reseller credentials are tied to ONE
     *   connected merchant per client instance.
     */
    constructor(basic) {
        this.basic = basic;
    }
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
    async createEcommerceSource(input) {
        requireNonEmptyString(input.domain, 'domain');
        requireNonEmptyString(input.pathSuccess, 'pathSuccess');
        requireNonEmptyString(input.pathFail, 'pathFail');
        requireNonEmptyString(input.name, 'name'); // Viva marks `name` required (new_source schema)
        validateSourceCode(input.sourceCode);
        const body = {
            domain: input.domain,
            isSecure: input.isSecure ?? true,
            pathFail: input.pathFail,
            pathSuccess: input.pathSuccess,
            name: input.name,
            sourceCode: input.sourceCode,
        };
        await this.basic.request({
            method: 'POST',
            path: '/api/sources',
            jsonBody: body,
            idempotent: true, // supplied sourceCode → 409 on duplicate = idempotent
            endpoint: 'POST /api/sources',
        });
        // Viva returns HTTP 200 with no body (payment-isv-api.yaml:279-284).
        // The caller already holds the sourceCode from the request input.
    }
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
    async createPhysicalSource(input) {
        requireNonEmptyString(input.name, 'name');
        validateSourceCode(input.sourceCode);
        const body = {
            isPhysical: true,
            name: input.name,
            sourceCode: input.sourceCode,
        };
        await this.basic.request({
            method: 'POST',
            path: '/api/sources',
            jsonBody: body,
            idempotent: true, // supplied sourceCode → 409 on duplicate = idempotent
            endpoint: 'POST /api/sources',
        });
        // Viva returns HTTP 200 with no body (payment-isv-api.yaml:279-284).
    }
}
exports.IsvSources = IsvSources;
//# sourceMappingURL=sources.js.map