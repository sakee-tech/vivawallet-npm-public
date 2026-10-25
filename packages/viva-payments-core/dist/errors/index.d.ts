/**
 * viva-payments-core/errors — barrel export.
 *
 * Subpath: `viva-payments-core/errors`
 *
 * All error classes extend `VivaError`. Callers can do:
 *   import { VivaError, VivaAuthError, VivaRateLimitError } from 'viva-payments-core/errors';
 */
export { VivaError } from './base.js';
export type { VivaErrorOptions } from './base.js';
export { VivaAuthError } from './auth-error.js';
export { VivaApiError } from './api-error.js';
export { VivaValidationError } from './validation-error.js';
export { VivaWebhookError } from './webhook-error.js';
export { VivaRateLimitError } from './rate-limit-error.js';
export type { VivaRateLimitErrorOptions } from './rate-limit-error.js';
export { VivaModeMismatchError } from './mode-mismatch-error.js';
//# sourceMappingURL=index.d.ts.map