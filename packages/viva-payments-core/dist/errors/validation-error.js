import { VivaError } from './base.js';
/**
 * Thrown for local pre-flight validation failures.
 *
 * Examples: multi-tenant cart rejected at `initiatePayment` (plan P19),
 * amount out of range, missing required field before the HTTP call is made.
 *
 * Maps to `MedusaError(Types.INVALID_DATA)` in the adapter layer.
 */
export class VivaValidationError extends VivaError {
    code = 'VIVA_VALIDATION_ERROR';
    constructor(opts) {
        super(opts);
        this.name = 'VivaValidationError';
    }
}
//# sourceMappingURL=validation-error.js.map