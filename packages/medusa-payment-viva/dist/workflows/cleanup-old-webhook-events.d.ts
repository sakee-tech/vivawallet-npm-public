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
export interface CleanupOldWebhookEventsCtx {
    pool: pg.Pool;
    /** Retention window in days. Default: 90. */
    retentionDays?: number;
    /** Soft cap per iteration to avoid long table locks. Default: 10000. */
    batchSize?: number;
    logger: {
        info(msg: string): void;
        warn(msg: string): void;
    };
}
export interface CleanupResult {
    deleted: number;
}
/**
 * Delete expired webhook events in batches.
 *
 * Loops until no rows are deleted in a batch (idempotent per invocation).
 * Uses a subquery-based DELETE to stay within `batchSize` rows per iteration.
 *
 * @see references/viva-docs/md/isv-partner-program.txt:104 (A12)
 */
export declare function cleanupOldWebhookEvents(ctx: CleanupOldWebhookEventsCtx): Promise<CleanupResult>;
//# sourceMappingURL=cleanup-old-webhook-events.d.ts.map