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
import type { Payments } from '@sakeetech/viva-payments-core/payments';
import type { VivaWebhookEnvelope } from '@sakeetech/viva-payments-core/types';
import type { VivaEventTypeId } from '@sakeetech/viva-payments-core/webhooks';
import type { MetricsHook } from '@sakeetech/viva-payments-core/observability';
import type { VivaMode } from '../config.js';
export type { MetricsHook };
export interface ProcessWebhookInput {
    /** viva_webhook_event_id (PK) */
    eventId: string;
    eventTypeId: VivaEventTypeId;
    envelope: VivaWebhookEnvelope;
    /** null when tenant resolution failed (A6) */
    tenantId: string | null;
}
export interface ProcessWebhookContext {
    pool: pg.Pool;
    isvPayments: Payments;
    logger: {
        info(msg: string): void;
        warn(msg: string): void;
        error(msg: string): void;
    };
    /** S10 will inject a real implementation; defaults to no-op. */
    metrics?: MetricsHook;
    /**
     * Plugin mode. When 'merchant', ISV-only events (8193/8194) are acknowledged
     * (processed_at set, no side effects). When undefined, defaults to 'isv' for
     * backward compatibility with callers that predate Phase 2 slice C.
     *
     * @see docs/plans/multi-mode-v0.md §6 (mode-surface gating)
     */
    mode?: VivaMode;
}
export interface ProcessWebhookResult {
    applied: boolean;
    reason?: string;
}
/**
 * Process a single viva_webhook_event row.
 *
 * Pure function: no Medusa-specific imports beyond types.
 * All DB access via raw pg.Pool (A3 requirement: no ORM transaction during HTTP).
 *
 * @see references/viva-docs/md/webhooks-for-payments.txt:248 (A3 fetch-then-lock)
 * @see references/viva-docs/md/isv-partner-program.txt:61 (A6 unresolved tenant)
 */
export declare function processWebhookEvent(input: ProcessWebhookInput, ctx: ProcessWebhookContext): Promise<ProcessWebhookResult>;
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
export declare function recordWebhookFailure(pool: pg.Pool, eventId: string, err: unknown): Promise<void>;
//# sourceMappingURL=process-webhook-event.d.ts.map