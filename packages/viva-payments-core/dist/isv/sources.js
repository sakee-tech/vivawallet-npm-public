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
const SOURCE_CODE_MIN = 1000;
const SOURCE_CODE_MAX = 9999;
function requireNonEmptyString(value, field) {
    if (typeof value !== 'string' || value.trim() === '') {
        throw new index_js_1.VivaValidationError({
            message: `IsvSources: ${field} is required and must be a non-empty string`,
        });
    }
}
function validateSourceCode(value) {
    if (value === undefined)
        return;
    if (!Number.isInteger(value) || value < SOURCE_CODE_MIN || value > SOURCE_CODE_MAX) {
        throw new index_js_1.VivaValidationError({
            message: `IsvSources: sourceCode must be a 4-digit integer in [${SOURCE_CODE_MIN}, ${SOURCE_CODE_MAX}]`,
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
        };
        if (input.sourceCode !== undefined) {
            body['sourceCode'] = input.sourceCode;
        }
        const result = await this.basic.request({
            method: 'POST',
            path: '/api/sources',
            jsonBody: body,
            idempotent: false,
            endpoint: 'POST /api/sources',
        });
        return result.data;
    }
    /**
     * Create a physical (in-store / terminal) payment source for the connected
     * merchant.
     *
     * @see docs/ENDPOINTS.md §5.1
     */
    async createPhysicalSource(input) {
        requireNonEmptyString(input.name, 'name');
        validateSourceCode(input.sourceCode);
        const body = {
            isPhysical: true,
            name: input.name,
        };
        if (input.sourceCode !== undefined) {
            body['sourceCode'] = input.sourceCode;
        }
        const result = await this.basic.request({
            method: 'POST',
            path: '/api/sources',
            jsonBody: body,
            idempotent: false,
            endpoint: 'POST /api/sources',
        });
        return result.data;
    }
}
exports.IsvSources = IsvSources;
//# sourceMappingURL=sources.js.map