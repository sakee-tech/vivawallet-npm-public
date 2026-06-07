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
 * HMAC verification is intentionally not performed here. Event 7936 (the
 * only HMAC-signed Viva event) is not subscribed; if it is ever added,
 * route a separate VIVA_WEBHOOK_HMAC_SECRET, NOT the public
 * VIVA_WEBHOOK_VERIFICATION_KEY. See CSO Finding #3.
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
import { Modules } from '@medusajs/framework/utils';
import pg from 'pg';
import { isAllowedSourceIp, isTransactionEvent, isOnboardingEvent, extractClientIp as extractClientIpCore, } from '@sakeetech/viva-payments-core/webhooks';
import { getSharedMetrics } from '../../../observability/index.js';
// ---------------------------------------------------------------------------
// GET — challenge-response
// ---------------------------------------------------------------------------
/**
 * Challenge-response for webhook URL registration.
 * Returns `{"Key": "<webhook_verification_key>"}` per Viva protocol.
 * No auth gate; only exercised at deployment time.
 *
 * @see references/viva-docs/md/webhooks-for-payments.txt:284 (challenge response)
 */
export const GET = async (_req, res) => {
    const key = process.env['VIVA_WEBHOOK_VERIFICATION_KEY'] ?? '';
    if (!key) {
        res.status(500).json({ error: 'VIVA_WEBHOOK_VERIFICATION_KEY is not configured' });
        return;
    }
    res.setHeader('Cache-Control', 'no-store');
    res.status(200).json({ Key: key });
};
// ---------------------------------------------------------------------------
// POST — event ingest
// ---------------------------------------------------------------------------
/**
 * POST event ingest handler.
 *
 * Steps:
 *   1. IP allowlist check (env-configured). 403 on rejection.
 *   2. Read rawBody captured by vivaWebhookRawBodyMiddleware.
 *   3. Parse JSON.
 *   4. If EventTypeId 7936: verify HMAC. 401 on mismatch.
 *   5. Resolve tenant via viva_tenant_merchant.
 *   6. INSERT INTO viva_webhook_event ... ON CONFLICT (message_id) DO NOTHING RETURNING viva_webhook_event_id.
 *   7. A2: only emit 'viva.webhook.received' when RETURNING produced a row.
 *   8. Always respond 200.
 *
 * @see references/viva-docs/md/webhooks-for-payments.txt:286 (POST flow)
 * @see references/viva-docs/md/wh-transaction-payment-created.txt:158 (event envelope)
 */
export const POST = async (req, res) => {
    const environment = (process.env['VIVA_ENVIRONMENT'] ?? 'demo');
    const extraAllowlist = parseExtraAllowlist(process.env['VIVA_WEBHOOK_IP_ALLOWLIST']);
    const trustedProxyDepth = parseTrustedProxyDepth(process.env['VIVA_TRUSTED_PROXY_DEPTH']);
    const metrics = getSharedMetrics();
    // ---- Step 1: IP allowlist (CSO Finding #2) ----
    // VIVA_TRUSTED_PROXY_DEPTH controls how many trailing X-Forwarded-For hops we
    // trust. Default 0 = socket only (safe for direct exposure); set to 1 for a
    // single reverse proxy, 2 for CDN+LB. Walking from the rightmost end means
    // attacker-injected leftmost values are ignored.
    const clientIp = extractClientIpCore(req, trustedProxyDepth);
    if (!isAllowedSourceIp(clientIp, environment, extraAllowlist)) {
        // Log metric for IP rejection but only 403 in non-dev environments.
        // In dev/test with IP_ALLOWLIST_BYPASS=true, allow through.
        if (process.env['VIVA_WEBHOOK_IP_ALLOWLIST_BYPASS'] !== 'true') {
            req.scope?.resolve?.('logger')?.warn?.(`[viva] Rejected webhook from disallowed IP ${clientIp} (env=${environment})`);
            metrics.counter('viva_webhook_received_total', { event_type_id: 'unknown', result: 'ip_rejected' });
            res.status(403).json({ error: 'Forbidden' });
            return;
        }
    }
    // ---- Step 2: Raw body ----
    const rawBody = req.rawBody;
    if (!rawBody || rawBody.length === 0) {
        res.status(200).end();
        return;
    }
    // ---- Step 3: Parse JSON ----
    let envelope;
    try {
        envelope = JSON.parse(rawBody.toString('utf-8'));
    }
    catch {
        // Malformed JSON — return 200 per plan (Viva retries are not helpful here)
        const logger = req.scope?.resolve?.('logger');
        logger?.error?.('[viva] Webhook POST: failed to parse JSON body');
        res.status(200).end();
        return;
    }
    const eventTypeId = envelope.EventTypeId;
    const messageId = envelope.MessageId;
    // ---- Compute processing lag (P16) ----
    // envelope.Created is an ISO8601 timestamp when present
    const createdTs = envelope['Created'];
    if (typeof createdTs === 'string') {
        const createdMs = new Date(createdTs).getTime();
        if (!isNaN(createdMs)) {
            const lagSeconds = (Date.now() - createdMs) / 1000;
            metrics.histogram('viva_webhook_processing_lag_seconds', lagSeconds);
        }
    }
    // ---- Step 4: HMAC verification ----
    // Plugin does NOT subscribe to event 7936 (Sale Transactions) — the only
    // Viva event that ships an HMAC signature. The handler used to verify 7936
    // signatures here, but it reused VIVA_WEBHOOK_VERIFICATION_KEY (a public,
    // browser-fetchable value) as the HMAC secret, which is incorrect by
    // Viva's protocol design (CSO Finding #3, dormant).
    //
    // If 7936 is ever added to the subscribed event list, route a SEPARATE
    // VIVA_WEBHOOK_HMAC_SECRET env var, NOT VIVA_WEBHOOK_VERIFICATION_KEY.
    // The `verifyHmacSignature` helper remains in
    // @sakeetech/viva-payments-core/webhooks for that future wiring.
    // @see docs/TODO-CSO.md "Finding 3"
    // @see references/viva-docs/md/wh-sale-transactions.txt:174
    // ---- Step 5: Resolve tenant ----
    const connString = process.env['DATABASE_URL'] ??
        `postgresql://${process.env['USER'] ?? 'postgres'}@localhost:5432/postgres`;
    const pool = new pg.Pool({ connectionString: connString, max: 1 });
    const logger = req.scope?.resolve?.('logger');
    let tenantId = null;
    let vivaMerchantId = null;
    let connectedAccountId = null;
    let transactionId = null;
    try {
        const eventData = envelope.EventData;
        if (isTransactionEvent(eventTypeId)) {
            const txData = eventData;
            vivaMerchantId = txData.MerchantId ?? null;
            transactionId = txData.TransactionId ?? null;
            connectedAccountId = txData.ConnectedAccountId ?? null;
            if (vivaMerchantId) {
                const client = await pool.connect();
                try {
                    const row = await client.query(`SELECT tenant_id FROM viva_tenant_merchant WHERE viva_merchant_id = $1 LIMIT 1`, [vivaMerchantId]);
                    tenantId = row.rows[0]?.tenant_id ?? null;
                }
                finally {
                    client.release();
                }
            }
        }
        else if (isOnboardingEvent(eventTypeId)) {
            const onbData = eventData;
            connectedAccountId = onbData.ConnectedAccountId ?? null;
            if (connectedAccountId) {
                const client = await pool.connect();
                try {
                    const row = await client.query(`SELECT tenant_id FROM viva_tenant_merchant WHERE connected_account_id = $1 LIMIT 1`, [connectedAccountId]);
                    tenantId = row.rows[0]?.tenant_id ?? null;
                }
                finally {
                    client.release();
                }
            }
        }
        if (!tenantId) {
            // A6: log metric but continue — INSERT with tenant_id=NULL
            logger?.warn?.(`[viva] Tenant resolution failed for event ${eventTypeId} message ${messageId} ` +
                `vivaMerchantId=${vivaMerchantId ?? 'null'} connectedAccountId=${connectedAccountId ?? 'null'}. ` +
                `Metric: viva_tenant_resolution_failures_total`);
            metrics.counter('viva_tenant_resolution_failures_total', { event_type_id: String(eventTypeId) });
        }
        // ---- Step 6: INSERT ... ON CONFLICT DO NOTHING RETURNING ----
        const client = await pool.connect();
        let insertedEventId = null;
        try {
            const result = await client.query(`INSERT INTO viva_webhook_event
           (transaction_id, event_type_id, message_id, viva_merchant_id, connected_account_id, raw_payload)
         VALUES ($1, $2, $3, $4, $5, $6)
         ON CONFLICT (message_id) DO NOTHING
         RETURNING viva_webhook_event_id`, [
                transactionId,
                eventTypeId,
                messageId,
                vivaMerchantId,
                connectedAccountId,
                JSON.stringify(envelope),
            ]);
            insertedEventId = result.rows[0]?.viva_webhook_event_id ?? null;
        }
        finally {
            client.release();
        }
        // ---- Step 7: A2 dispatch gate — only emit when RETURNING returned a row ----
        if (insertedEventId) {
            metrics.counter('viva_webhook_received_total', {
                event_type_id: String(eventTypeId),
                result: tenantId ? 'accepted' : 'tenant_unresolved',
            });
            const eventBus = req.scope?.resolve?.(Modules.EVENT_BUS);
            if (eventBus) {
                await eventBus.emit({
                    name: 'viva.webhook.received',
                    data: {
                        eventId: insertedEventId,
                        tenantId: tenantId,
                        eventTypeId,
                        transactionId,
                        vivaMerchantId,
                        connectedAccountId,
                    },
                });
            }
        }
        else {
            // Duplicate — ON CONFLICT hit
            metrics.counter('viva_webhook_received_total', {
                event_type_id: String(eventTypeId),
                result: 'duplicate',
            });
        }
    }
    catch (err) {
        logger?.error?.(`[viva] Webhook POST error for message ${messageId}: ${err instanceof Error ? err.message : String(err)}`);
        // Still return 200 so Viva doesn't retry unnecessarily
    }
    finally {
        await pool.end().catch(() => undefined);
    }
    // ---- Step 8: Always 200 ----
    res.status(200).end();
};
// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function parseExtraAllowlist(raw) {
    if (!raw)
        return [];
    return raw.split(',').map((s) => s.trim()).filter(Boolean);
}
function parseTrustedProxyDepth(raw) {
    if (!raw)
        return 0;
    const n = Number.parseInt(raw, 10);
    if (Number.isNaN(n) || n < 0)
        return 0;
    return n;
}
//# sourceMappingURL=route.js.map