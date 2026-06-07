import { VivaError } from './base.js';
/**
 * Thrown when authentication with Viva fails.
 *
 * Causes: bad credentials, expired token, 401/403 from `/connect/token`,
 * or a second 401 after a forced token refresh (likely rotated client_secret).
 *
 * Maps to `MedusaError(Types.UNAUTHORIZED)` in the Medusa adapter layer.
 */
export class VivaAuthError extends VivaError {
    code = 'VIVA_AUTH_ERROR';
    constructor(opts) {
        super(opts);
        this.name = 'VivaAuthError';
    }
}
//# sourceMappingURL=auth-error.js.map