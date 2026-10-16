"use strict";
/**
 * IsvWebhooks — ISV Webhook Registration API.
 *
 * Probe-verified 2026-05-11. Endpoints below match `docs/payment-isv-api.yaml`.
 *
 *   - registerWebhook     → POST /isv/v1/webhooks               (204 No Content)
 *   - getVerificationKey  → GET  /isv/v1/webhooks/token         (200 {key})
 *
 * Intentionally absent — these endpoints are NOT exposed by the ISV API:
 *
 *   - listWebhooks       (no GET on /isv/v1/webhooks; only POST)
 *   - deactivate/delete  (no PATCH/DELETE; manage existing entries via the
 *                         banking UI or by re-registering)
 *
 * Auth: OAuth2 Bearer with scopes
 *   `urn:viva:payments:core:api:isv urn:viva:payments:core:api:redirectcheckout`.
 *
 * Limits: max 10 URLs per `eventTypeId`. Exceeding the cap returns HTTP 400
 * with `eventId: 3732` (`SecurityCreateWebhookFailedLimitReached`).
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.IsvWebhooks = void 0;
const index_js_1 = require("../errors/index.js");
class IsvWebhooks {
    client;
    constructor(client) {
        this.client = client;
    }
    /**
     * Register a webhook URL for an event type.
     *
     * Server returns 204 No Content on success. Re-posting the same URL for
     * the same event type does not error — it is the caller's responsibility
     * to avoid duplicates (the API has no list endpoint).
     *
     * Throws `VivaApiError` with `vivaCode: '3732'` if the 10-URL-per-event cap
     * is exceeded.
     */
    async registerWebhook(req) {
        // Hard-fail on missing spec-required fields (create_webhook_request schema,
        // payment-isv-api.yaml:7127 marks both `url` + `eventTypeId` required) so a
        // bad registration fails locally instead of as an opaque Viva 4xx.
        if (!Number.isInteger(req.eventTypeId) || req.eventTypeId <= 0) {
            throw new index_js_1.VivaValidationError({
                message: `IsvWebhooks: eventTypeId is required and must be a positive integer, got ${String(req.eventTypeId)}`,
            });
        }
        if (typeof req.url !== 'string' || !/^https:\/\//i.test(req.url.trim())) {
            throw new index_js_1.VivaValidationError({
                message: `IsvWebhooks: url is required and must be an https:// URL, got "${String(req.url)}"`,
            });
        }
        await this.client.request({
            method: 'POST',
            path: '/isv/v1/webhooks',
            body: {
                eventTypeId: req.eventTypeId,
                url: req.url,
            },
            idempotent: true,
            endpoint: 'POST /isv/v1/webhooks',
        });
    }
    /**
     * Retrieve the ISV-level webhook verification key.
     *
     * The returned `key` must be echoed in the JSON response to the URL-verify
     * GET handshake Viva performs against the webhook endpoint.
     *
     * Note: a single key is issued per ISV account; it does not vary per
     * registered URL.
     */
    async getVerificationKey() {
        return this.client.request({
            method: 'GET',
            path: '/isv/v1/webhooks/token',
            idempotent: true,
            endpoint: 'GET /isv/v1/webhooks/token',
        });
    }
}
exports.IsvWebhooks = IsvWebhooks;
//# sourceMappingURL=webhooks-api.js.map