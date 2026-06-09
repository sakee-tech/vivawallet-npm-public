"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.VivaRateLimitError = void 0;
const base_js_1 = require("./base.js");
/**
 * Thrown when Viva returns HTTP 429 (Too Many Requests) or a retriable 5xx.
 *
 * `retriable` is always `true`. The caller (or retry policy in S3) uses
 * `retryAfterMs` when present; otherwise falls back to exponential backoff
 * per plan Auth Flow line 319.
 */
class VivaRateLimitError extends base_js_1.VivaError {
    code = 'VIVA_RATE_LIMIT_ERROR';
    retriable = true;
    /** Milliseconds to wait before retrying, from `Retry-After` header. */
    retryAfterMs;
    constructor(opts) {
        super(opts);
        this.name = 'VivaRateLimitError';
        this.retryAfterMs = opts.retryAfterMs;
    }
}
exports.VivaRateLimitError = VivaRateLimitError;
//# sourceMappingURL=rate-limit-error.js.map