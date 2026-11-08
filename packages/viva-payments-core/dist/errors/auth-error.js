"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.VivaAuthError = void 0;
const base_js_1 = require("./base.js");
/**
 * Thrown when authentication with Viva fails.
 *
 * Causes: bad credentials, expired token, 401/403 from `/connect/token`,
 * or a second 401 after a forced token refresh (likely rotated client_secret).
 *
 * Maps to `MedusaError(Types.UNAUTHORIZED)` in the Medusa adapter layer.
 */
class VivaAuthError extends base_js_1.VivaError {
    code = 'VIVA_AUTH_ERROR';
    constructor(opts) {
        super(opts);
        this.name = 'VivaAuthError';
    }
}
exports.VivaAuthError = VivaAuthError;
//# sourceMappingURL=auth-error.js.map