/**
 * cleanup-old-webhook-events.ts — A12 retention cleanup job.
 *
 * Deletes viva_webhook_event rows older than `retentionDays` (default: 90).
 * Runs in batches to avoid long lock windows.
 *
 * Freshness check (A12 extended):
 * TODO: implement metric `viva_webhook_processing_lag_seconds` — emit a gauge
 * measuring time since the latest processed webhook per tenant. If > 25h AND
 * recent transactions exist, emit a warning level event so the operator knows
 * Viva webhooks may have stopped arriving. S10 owns the full implementation.
 *
 * @see references/viva-docs/md/isv-partner-program.txt:104 (A12 retention policy)
 */
import pg from 'pg';
// ---------------------------------------------------------------------------
// Main function
// ---------------------------------------------------------------------------
/**
 * Delete expired webhook events in batches.
 *
 * Loops until no rows are deleted in a batch (idempotent per invocation).
 * Uses a subquery-based DELETE to stay within `batchSize` rows per iteration.
 *
 * @see references/viva-docs/md/isv-partner-program.txt:104 (A12)
 */
export async function cleanupOldWebhookEvents(ctx) {
    const { pool, retentionDays = 90, batchSize = 10_000, logger, } = ctx;
    // TODO(S10): implement freshness check metric `viva_webhook_processing_lag_seconds`.
    // For each tenant, SELECT max(received_at) FROM viva_webhook_event.
    // If max(received_at) < now() - interval '25h' AND tenant has recent transactions,
    // emit a warning gauge with label tenant_id.
    // @see references/viva-docs/md/isv-partner-program.txt:104 (A12 freshness)
    let totalDeleted = 0;
    for (;;) {
        const client = await pool.connect();
        let rowCount = 0;
        try {
            const result = await client.query(`DELETE FROM viva_webhook_event
          WHERE viva_webhook_event_id IN (
            SELECT viva_webhook_event_id
              FROM viva_webhook_event
             WHERE received_at < now() - make_interval(days => $1)
             LIMIT $2
          )`, [retentionDays, batchSize]);
            rowCount = result.rowCount ?? 0;
        }
        finally {
            client.release();
        }
        if (rowCount > 0) {
            totalDeleted += rowCount;
            logger.info(`[viva] cleanupOldWebhookEvents: deleted ${rowCount} rows (total so far: ${totalDeleted})`);
        }
        if (rowCount === 0)
            break;
    }
    if (totalDeleted === 0) {
        logger.info(`[viva] cleanupOldWebhookEvents: no events older than ${retentionDays} days to delete.`);
    }
    else {
        logger.info(`[viva] cleanupOldWebhookEvents: complete. Total deleted: ${totalDeleted}`);
    }
    return { deleted: totalDeleted };
}
//# sourceMappingURL=cleanup-old-webhook-events.js.map