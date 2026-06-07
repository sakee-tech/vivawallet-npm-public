/**
 * reprocess-unresolved-tenants.ts — A6 reprocess job.
 *
 * Polls for webhook events that arrived with tenant_id=NULL (unresolved merchant)
 * and retries tenant resolution. If resolved: links transaction_id and re-emits
 * 'viva.webhook.received' for the subscriber to process. If exhausted: marks
 * processed_at and logs 'ABANDONED'.
 *
 * Uses the `retry_count` column added by Migration_20260425000003_webhook_retry_count.
 *
 * @see references/viva-docs/md/isv-partner-program.txt:61 (A6 tenant fallback)
 */
import pg from 'pg';
import type { MetricsHook } from './process-webhook-event.js';
export interface ReprocessUnresolvedCtx {
    pool: pg.Pool;
    /**
     * Re-runs tenant resolution. Returns { tenantId } if resolved, null if still unresolved.
     */
    resolveMerchant: (vivaMerchantId: string | null, connectedAccountId: string | null) => Promise<{
        tenantId: string;
    } | null>;
    /**
     * Optional event bus emit function. Injected by the subscriber/job runner.
     * If absent, re-emission is skipped (test mode).
     */
    emitEvent?: (eventName: string, data: Record<string, unknown>) => Promise<void>;
    logger: {
        info(msg: string): void;
        warn(msg: string): void;
        error(msg: string): void;
    };
    metrics?: MetricsHook;
    /** Minimum age in seconds before an unresolved event is eligible for retry. Default: 30. */
    minAgeSeconds?: number;
    /** Maximum retry attempts before abandoning. Default: 24. */
    maxRetries?: number;
}
export interface ReprocessResult {
    retried: number;
    resolved: number;
    abandoned: number;
}
/**
 * Retry tenant resolution for unprocessed webhook events with NULL tenant.
 *
 * Query: SELECT events WHERE processed_at IS NULL AND received_at < now() - $minAge
 *        AND retry_count < $maxRetries.
 *
 * Per-row:
 *   - If resolved: emit 'viva.webhook.received' and increment retry_count.
 *   - If still unresolved AND retry_count >= maxRetries - 1: mark processed_at (ABANDONED).
 *   - Otherwise: increment retry_count only.
 *
 * @see references/viva-docs/md/isv-partner-program.txt:61 (A6)
 */
export declare function reprocessUnresolvedTenants(ctx: ReprocessUnresolvedCtx): Promise<ReprocessResult>;
//# sourceMappingURL=reprocess-unresolved-tenants.d.ts.map