"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.VivaWebhookError = void 0;
const base_js_1 = require("./base.js");
/**
 * Thrown when webhook verification or shape validation fails.
 *
 * Covers: HMAC signature mismatch, unknown event type, malformed payload,
 * IP allowlist rejection (layer a), challenge-response failure (layer b).
 *
 * The webhook handler returns 401 (no payload processing) when this is thrown.
 */
class VivaWebhookError extends base_js_1.VivaError {
    code = 'VIVA_WEBHOOK_ERROR';
    constructor(opts) {
        super(opts);
        this.name = 'VivaWebhookError';
    }
}
exports.VivaWebhookError = VivaWebhookError;
//# sourceMappingURL=webhook-error.js.map