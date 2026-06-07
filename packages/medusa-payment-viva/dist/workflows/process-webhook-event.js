/**
 * process-webhook-event.ts — Fetch-then-lock webhook processor (A3).
 *
 * Implements the A3 pattern:
 *   1. Retrieve transaction from Viva API OUTSIDE any DB transaction.
 *   2. BEGIN; SELECT ... FOR UPDATE; re-validate lattice; UPDATE; COMMIT.
 *   Never hold a row lock across network I/O.
 *
 * Handles:
 *   - TENANT_UNRESOLVED (A6): return early, do not write.
 *   - Onboarding events (8193/8194): update viva_tenant_merchant.verification_status.
 *   - Transaction events (1796/1797/1798/4865): fetch live state, apply lattice.
 *   - Backward/terminal transitions: mark processed_at, return applied:false.
 *   - Missing transaction row: mark processed_at, return NO_TRANSACTION_ROW.
 *
 * @see references/viva-docs/md/webhooks-for-payments.txt:248 (retrieve before update)
 * @see references/viva-docs/md/isv-partner-program.txt:61 (P17 status lattice, A3, A6)
 */
import pg from 'pg';
import { validateStatusTransition, mapStatusLetter, isTransactionEvent, isOnboardingEvent, } from '@sakeetech/viva-payments-core/webhooks';
import { VivaApiError } from '@sakeetech/viva-payments-core/errors';
// ---------------------------------------------------------------------------
// Main function
// ---------------------------------------------------------------------------
/**
 * Process a single viva_webhook_event row.
 *
 * Pure function: no Medusa-specific imports beyond types.
 * All DB access via raw pg.Pool (A3 requirement: no ORM transaction during HTTP).
 *
 * @see references/viva-docs/md/webhooks-for-payments.txt:248 (A3 fetch-then-lock)
 * @see references/viva-docs/md/isv-partner-program.txt:61 (A6 unresolved tenant)
 */
export async function processWebhookEvent(input, ctx) {
    const { eventId, eventTypeId, envelope, tenantId } = input;
    const { pool, isvPayments, logger, metrics, mode } = ctx;
    const effectiveMode = mode ?? 'isv';
    // ---- Mode gating for ISV-only onboarding events (8193 / 8194) ----
    // In merchant mode, these events should not arrive — but if Viva ever sends
    // one (e.g. mis-routed webhook), acknowledge it (markProcessed) without
    // touching viva_tenant_merchant. The tenant unresolved branch below would
    // also catch most of these, but gate on mode first so the log message is
    // accurate and we don't increment the tenant_resolution_failures metric.
    //
    // @see docs/plans/multi-mode-v0.md §6 (mode-surface gating)
    if (isOnboardingEvent(eventTypeId) && effectiveMode === 'merchant') {
        logger.warn(`[viva] ${eventTypeId} received in merchant mode — ignored (eventId=${eventId})`);
        await markProcessed(pool, eventId);
        return { applied: false, reason: 'MODE_GATED' };
    }
    // ---- A6: tenant unresolved ----
    if (!tenantId) {
        metrics?.counter('viva_tenant_resolution_failures_total', {
            event_type_id: String(eventTypeId),
        });
        logger.warn(`[viva] processWebhookEvent: tenantId is null for eventId=${eventId} eventTypeId=${eventTypeId}. ` +
            `Subscriber reprocess path (A6) will retry.`);
        return { applied: false, reason: 'TENANT_UNRESOLVED' };
    }
    // ---- Onboarding events (8193 / 8194) — ISV mode only ----
    if (isOnboardingEvent(eventTypeId)) {
        return processOnboardingEvent(eventId, eventTypeId, envelope, pool, logger);
    }
    // ---- Transaction events ----
    if (isTransactionEvent(eventTypeId)) {
        return processTransactionEvent(eventId, eventTypeId, envelope, pool, isvPayments, logger, metrics);
    }
    // Unknown event type — mark processed
    logger.warn(`[viva] processWebhookEvent: unknown eventTypeId=${eventTypeId} eventId=${eventId}. Marking processed.`);
    await markProcessed(pool, eventId);
    return { applied: false, reason: 'UNKNOWN_EVENT_TYPE' };
}
// ---------------------------------------------------------------------------
// Onboarding event processing
// ---------------------------------------------------------------------------
async function processOnboardingEvent(eventId, eventTypeId, envelope, pool, logger) {
    const eventData = envelope.EventData;
    const connectedAccountId = eventData.ConnectedAccountId;
    if (!connectedAccountId) {
        logger.warn(`[viva] Onboarding event ${eventTypeId} eventId=${eventId}: no ConnectedAccountId in payload.`);
        await markProcessed(pool, eventId);
        return { applied: false, reason: 'NO_CONNECTED_ACCOUNT_ID' };
    }
    const client = await pool.connect();
    try {
        // 8194: update verification_status if present
        if (eventTypeId === 8194) {
            const verified = eventData.Verified;
            if (verified !== undefined) {
                await client.query(`UPDATE viva_tenant_merchant
             SET verification_status = $1, updated_at = now()
           WHERE connected_account_id = $2`, [verified ? 'verified' : 'unverified', connectedAccountId]);
            }
        }
        await markProcessed(pool, eventId);
        logger.info(`[viva] Onboarding event ${eventTypeId} processed eventId=${eventId} connectedAccountId=${connectedAccountId}`);
        return { applied: true };
    }
    finally {
        client.release();
    }
}
// ---------------------------------------------------------------------------
// Transaction event processing (A3 fetch-then-lock)
// ---------------------------------------------------------------------------
async function processTransactionEvent(eventId, eventTypeId, envelope, pool, isvPayments, logger, metrics) {
    const eventData = envelope.EventData;
    const vivaTransactionId = eventData.TransactionId;
    const merchantId = eventData.MerchantId;
    if (!vivaTransactionId) {
        logger.warn(`[viva] Transaction event ${eventTypeId} eventId=${eventId}: no TransactionId in payload. Marking processed.`);
        await markProcessed(pool, eventId);
        return { applied: false, reason: 'NO_TRANSACTION_ID' };
    }
    // ---- A3 Step a: Fetch OUTSIDE any DB transaction ----
    // Call Viva's Retrieve Transaction API before opening a lock.
    // Per Viva docs: "before updating a transaction's status on your system,
    // you SHOULD always retrieve its details from Viva".
    // @see references/viva-docs/md/webhooks-for-payments.txt:248
    let liveStatusLetter;
    let liveRawPayload;
    let liveOrderCode = null;
    try {
        const live = await isvPayments.retrieveTransaction(vivaTransactionId, merchantId ? { merchantId: merchantId } : {});
        liveStatusLetter = live.statusId;
        liveRawPayload = live;
        liveOrderCode = live.orderCode != null ? String(live.orderCode) : null;
        // CSO-Finding-1: cross-check live.orderCode against envelope OrderCode
        // before any state mutation. Matches Viva's canonical WooCommerce plugin
        // pattern (class-wc-vivacom-smart-endpoints.php:132). Without this an
        // attacker holding any real paid transactionId could forge an envelope
        // pointing at a victim's OrderCode and we would mark that row paid.
        const envOrderCodeStr = eventData.OrderCode != null ? String(eventData.OrderCode) : null;
        if (envOrderCodeStr && liveOrderCode && envOrderCodeStr !== liveOrderCode) {
            logger.warn(`[viva] orderCode mismatch — envelope=${envOrderCodeStr} live=${liveOrderCode} ` +
                `eventId=${eventId} txId=${vivaTransactionId}. Rejecting forged event.`);
            metrics?.counter('viva_webhook_ordercode_mismatch_total', {
                event_type_id: String(eventTypeId),
            });
            await markProcessed(pool, eventId);
            return { applied: false, reason: 'ORDERCODE_MISMATCH' };
        }
    }
    catch (err) {
        if (err instanceof VivaApiError) {
            // Re-throw to let the subscriber retry via backoff
            throw err;
        }
        logger.error(`[viva] retrieveTransaction failed for transactionId=${vivaTransactionId} eventId=${eventId}: ` +
            `${err instanceof Error ? err.message : String(err)}`);
        throw err;
    }
    // Map status letter → internal status
    // liveStatusLetter comes from Viva API, cast to VivaStatusLetter after runtime validation.
    // @see references/viva-docs/md/wh-transaction-payment-created.txt:398
    const { status: derivedNext, claimSubstate } = mapStatusLetter(liveStatusLetter);
    // ---- A3 Step b: Lock + update inside DB transaction ----
    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        // Find the transaction row by Viva's transactionId (stored in raw_payload or by looking up order code).
        // We look up by viva_order_code when available, otherwise fall back to raw_payload lookup.
        // The TransactionId in the webhook EventData is Viva's transaction UUID.
        // viva_transaction stores our internal UUID as PK. We need to find the row
        // that matches this specific Viva transaction.
        //
        // Strategy: look up by the OrderCode from the event data to find the row,
        // then SELECT FOR UPDATE.
        // After the mismatch check above, liveOrderCode is the verified source of
        // truth (envelope OrderCode is attacker-controlled; live.orderCode is from
        // Viva's authenticated retrieveTransaction call).
        const orderCode = liveOrderCode;
        let txRow = null;
        if (orderCode) {
            const result = await client.query(`SELECT viva_transaction_id, status, claim_substate, raw_payload
           FROM viva_transaction
          WHERE viva_order_code = $1
          FOR UPDATE`, [orderCode]);
            txRow = result.rows[0] ?? null;
        }
        if (!txRow) {
            await client.query('ROLLBACK');
            logger.warn(`[viva] No viva_transaction row found for orderCode=${orderCode ?? 'null'} ` +
                `transactionId=${vivaTransactionId} eventId=${eventId}. Marking processed.`);
            await markProcessed(pool, eventId);
            return { applied: false, reason: 'NO_TRANSACTION_ROW' };
        }
        // Re-validate lattice
        const transition = validateStatusTransition(txRow.status, derivedNext);
        if (!transition.ok) {
            await client.query('ROLLBACK');
            logger.warn(`[viva] Lattice rejected ${txRow.status} → ${derivedNext} ` +
                `(reason=${transition.reason}) for txId=${txRow.viva_transaction_id} eventId=${eventId}. No-op.`);
            metrics?.counter('viva_webhook_lattice_reject_total', {
                reason: transition.reason,
                event_type_id: String(eventTypeId),
            });
            // Still mark processed — we processed it and decided to no-op
            await markProcessed(pool, eventId);
            return { applied: false, reason: transition.reason };
        }
        // Apply the transition
        await client.query(`UPDATE viva_transaction
          SET status = $1,
              claim_substate = $2,
              raw_payload = $3,
              updated_at = now()
        WHERE viva_transaction_id = $4`, [
            transition.next,
            claimSubstate,
            JSON.stringify(liveRawPayload),
            txRow.viva_transaction_id,
        ]);
        // Mark event processed
        await client.query(`UPDATE viva_webhook_event SET processed_at = now() WHERE viva_webhook_event_id = $1`, [eventId]);
        await client.query('COMMIT');
        logger.info(`[viva] Transaction event ${eventTypeId} applied: ` +
            `${txRow.status} → ${transition.next} for txId=${txRow.viva_transaction_id} eventId=${eventId}`);
        return { applied: true };
    }
    catch (err) {
        await client.query('ROLLBACK').catch(() => undefined);
        throw err;
    }
    finally {
        client.release();
    }
}
// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
async function markProcessed(pool, eventId) {
    const client = await pool.connect();
    try {
        await client.query(`UPDATE viva_webhook_event SET processed_at = now() WHERE viva_webhook_event_id = $1`, [eventId]);
    }
    finally {
        client.release();
    }
}
/**
 * Record a webhook processing failure on the event row.
 *
 * Writes a JSON envelope to viva_webhook_event.error and bumps retry_count.
 * Leaves processed_at NULL so the job runner / reaper picks the row up again.
 *
 * Called from the subscriber when processWebhookEvent throws. Best-effort:
 * never throws — a failure to record a failure must not mask the original
 * error or stop the job runner from retrying.
 *
 * @see docs/ERRORS.md §6 (operator playbook reads this column)
 */
export async function recordWebhookFailure(pool, eventId, err) {
    const envelope = {
        name: err instanceof Error ? err.name : 'UnknownError',
        message: err instanceof Error ? err.message : String(err),
        code: err?.code,
        stack: err instanceof Error ? err.stack : undefined,
        at: new Date().toISOString(),
    };
    let client = null;
    try {
        client = await pool.connect();
        await client.query(`UPDATE viva_webhook_event
          SET error = $1,
              retry_count = retry_count + 1
        WHERE viva_webhook_event_id = $2`, [JSON.stringify(envelope), eventId]);
    }
    catch {
        // swallow — never let failure-recording hide the original failure.
    }
    finally {
        if (client)
            client.release();
    }
}
//# sourceMappingURL=process-webhook-event.js.map