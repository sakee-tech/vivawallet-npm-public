import { VivaError } from './base.js';
/**
 * Thrown when webhook verification or shape validation fails.
 *
 * Covers: HMAC signature mismatch, unknown event type, malformed payload,
 * IP allowlist rejection (layer a), challenge-response failure (layer b).
 *
 * The webhook handler returns 401 (no payload processing) when this is thrown.
 */
export class VivaWebhookError extends VivaError {
    code = 'VIVA_WEBHOOK_ERROR';
    constructor(opts) {
        super(opts);
        this.name = 'VivaWebhookError';
    }
}
//# sourceMappingURL=webhook-error.js.map