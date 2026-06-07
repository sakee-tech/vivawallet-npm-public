/**
 * ISV Connected Account + Webhook Registration types.
 *
 * Probe-verified 2026-05-11 against `docs/payment-isv-api.yaml`. All shapes
 * below match the live demo response observed at `demo-api.vivapayments.com`.
 *
 * Endpoints (all Bearer auth, OAuth2 scopes
 * `urn:viva:payments:core:api:isv urn:viva:payments:core:api:redirectcheckout`):
 *
 *   - POST /isv/v1/accounts                 — create connected account
 *   - GET  /isv/v1/accounts/{accountId}     — retrieve connected account
 *   - POST /isv/v1/webhooks                 — register webhook (204 No Content)
 *   - GET  /isv/v1/webhooks/token           — generate verification key
 *
 * Endpoints NOT in the ISV spec (intentionally absent from this module):
 *
 *   - List webhooks  (not exposed; CLI must rely on POST idempotency)
 *   - Update/Delete webhook  (not exposed; manage via banking UI)
 *   - Update connected account  (not exposed for ISV; merchant edits via UI)
 */
export {};
//# sourceMappingURL=isv-accounts.js.map