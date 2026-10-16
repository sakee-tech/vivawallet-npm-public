import { VivaError, type VivaErrorOptions } from './base.js';

/**
 * Thrown for local pre-flight validation failures.
 *
 * Examples: multi-tenant cart rejected at `initiatePayment` (plan P19),
 * amount out of range, missing required field before the HTTP call is made.
 *
 * Maps to `MedusaError(Types.INVALID_DATA)` in the adapter layer.
 */
export class VivaValidationError extends VivaError {
  readonly code = 'VIVA_VALIDATION_ERROR' as const;

  constructor(opts: VivaErrorOptions) {
    super(opts);
    this.name = 'VivaValidationError';
  }
}
