import { VivaError, type VivaErrorOptions } from './base.js';
export interface VivaRateLimitErrorOptions extends VivaErrorOptions {
    /** Milliseconds to wait before retrying, derived from `Retry-After` header. */
    retryAfterMs?: number | undefined;
}
/**
 * Thrown when Viva returns HTTP 429 (Too Many Requests) or a retriable 5xx.
 *
 * `retriable` is always `true`. The caller (or retry policy in S3) uses
 * `retryAfterMs` when present; otherwise falls back to exponential backoff
 * per plan Auth Flow line 319.
 */
export declare class VivaRateLimitError extends VivaError {
    readonly code: "VIVA_RATE_LIMIT_ERROR";
    readonly retriable: true;
    /** Milliseconds to wait before retrying, from `Retry-After` header. */
    readonly retryAfterMs: number | undefined;
    constructor(opts: VivaRateLimitErrorOptions);
}
//# sourceMappingURL=rate-limit-error.d.ts.map