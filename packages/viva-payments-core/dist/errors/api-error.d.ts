import { VivaError, type VivaErrorOptions } from './base.js';
/**
 * Thrown when the Viva API returns a 4xx or 5xx response on a non-auth call,
 * or when a network-level error occurs.
 *
 * The `vivaCode` field carries Viva's error code from the response body when
 * available. The `cause` field wraps the underlying network or fetch error.
 *
 * Maps to `MedusaError(Types.PAYMENT_AUTHORIZATION_ERROR)` in the adapter.
 */
export declare class VivaApiError extends VivaError {
    readonly code: "VIVA_API_ERROR";
    constructor(opts: VivaErrorOptions);
}
//# sourceMappingURL=api-error.d.ts.map