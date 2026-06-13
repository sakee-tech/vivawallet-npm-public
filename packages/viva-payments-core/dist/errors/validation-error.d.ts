import { VivaError, type VivaErrorOptions } from './base.js';
/**
 * Thrown for local pre-flight validation failures.
 *
 * Examples: multi-tenant cart rejected at `initiatePayment` (plan P19),
 * amount out of range, missing required field before the HTTP call is made.
 *
 * Maps to `MedusaError(Types.INVALID_DATA)` in the adapter layer.
 */
export declare class VivaValidationError extends VivaError {
    readonly code: "VIVA_VALIDATION_ERROR";
    constructor(opts: VivaErrorOptions);
}
//# sourceMappingURL=validation-error.d.ts.map