"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.VivaValidationError = void 0;
const base_js_1 = require("./base.js");
/**
 * Thrown for local pre-flight validation failures.
 *
 * Examples: multi-tenant cart rejected at `initiatePayment` (plan P19),
 * amount out of range, missing required field before the HTTP call is made.
 *
 * Maps to `MedusaError(Types.INVALID_DATA)` in the adapter layer.
 */
class VivaValidationError extends base_js_1.VivaError {
    code = 'VIVA_VALIDATION_ERROR';
    constructor(opts) {
        super(opts);
        this.name = 'VivaValidationError';
    }
}
exports.VivaValidationError = VivaValidationError;
//# sourceMappingURL=validation-error.js.map