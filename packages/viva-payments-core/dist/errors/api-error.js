import { VivaError } from './base.js';
/**
 * Thrown when the Viva API returns a 4xx or 5xx response on a non-auth call,
 * or when a network-level error occurs.
 *
 * The `vivaCode` field carries Viva's error code from the response body when
 * available. The `cause` field wraps the underlying network or fetch error.
 *
 * Maps to `MedusaError(Types.PAYMENT_AUTHORIZATION_ERROR)` in the adapter.
 */
export class VivaApiError extends VivaError {
    code = 'VIVA_API_ERROR';
    constructor(opts) {
        super(opts);
        this.name = 'VivaApiError';
    }
}
//# sourceMappingURL=api-error.js.map