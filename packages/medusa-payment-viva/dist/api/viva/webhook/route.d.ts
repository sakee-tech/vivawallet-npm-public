/**
 * route.ts — Viva Wallet webhook endpoint.
 *
 * Two handlers:
 *   GET  /viva/webhook  — challenge-response for URL registration.
 *   POST /viva/webhook  — event ingest: IP check, INSERT + emit.
 *
 * Security model (plan P7):
 *   (a) IP allowlist   — 403 on mismatch. Source IP is extracted with
 *                        trustedProxyDepth-bounded X-Forwarded-For walking
 *                        (CSO Finding #2). Configure via
 *                        VIVA_TRUSTED_PROXY_DEPTH (default 0 = socket only).
 *   (b) DB dedup       — INSERT ... ON CONFLICT (message_id) DO NOTHING.
 *   (c) A2 gate        — only emit 'viva.webhook.received' when RETURNING non-empty.
 *
 * No HMAC / body-signature check: Viva does not sign payment webhooks. Auth is
 * the IP allowlist (a) plus the GET URL-verification handshake at registration.
 *
 * Metrics emitted (P16):
 *   viva_webhook_received_total{event_type_id, result}
 *   viva_webhook_processing_lag_seconds
 *   viva_tenant_resolution_failures_total
 *   viva_webhook_ordercode_mismatch_total
 *
 * @see references/viva-docs/md/webhooks-for-payments.txt:270 (IP allowlist)
 * @see references/viva-docs/md/webhooks-for-payments.txt:254 (security model P7)
 * @see docs/TODO-CSO.md (Findings 1, 2, 3)
 */
import type { MedusaRequest, MedusaResponse } from '@medusajs/framework/http';
/**
 * Challenge-response for webhook URL registration.
 * Returns `{"Key": "<webhook_verification_key>"}` per Viva protocol.
 * No auth gate; only exercised at deployment time.
 *
 * @see references/viva-docs/md/webhooks-for-payments.txt:284 (challenge response)
 */
export declare const GET: (_req: MedusaRequest, res: MedusaResponse) => Promise<void>;
/**
 * POST event ingest handler.
 *
 * Steps:
 *   1. IP allowlist check (env-configured). 403 on rejection.
 *   2. Read rawBody captured by vivaWebhookRawBodyMiddleware.
 *   3. Parse JSON.
 *   4. Resolve tenant via viva_tenant_merchant.
 *   5. INSERT INTO viva_webhook_event ... ON CONFLICT (message_id) DO NOTHING RETURNING viva_webhook_event_id.
 *   6. A2: only emit 'viva.webhook.received' when RETURNING produced a row.
 *   7. Always respond 200.
 *
 * @see references/viva-docs/md/webhooks-for-payments.txt:286 (POST flow)
 * @see references/viva-docs/md/wh-transaction-payment-created.txt:158 (event envelope)
 */
export declare const POST: (req: MedusaRequest, res: MedusaResponse) => Promise<void>;
//# sourceMappingURL=route.d.ts.map