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

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ReprocessUnresolvedCtx {
  pool: pg.Pool;
  /**
   * Re-runs tenant resolution. Returns { tenantId } if resolved, null if still unresolved.
   */
  resolveMerchant: (
    vivaMerchantId: string | null,
    connectedAccountId: string | null,
  ) => Promise<{ tenantId: string } | null>;
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

// ---------------------------------------------------------------------------
// Candidate row shape
// ---------------------------------------------------------------------------

interface UnresolvedEventRow {
  viva_webhook_event_id: string;
  event_type_id: number;
  viva_merchant_id: string | null;
  connected_account_id: string | null;
  transaction_id: string | null;
  retry_count: number;
  raw_payload: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Main function
// ---------------------------------------------------------------------------

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
export async function reprocessUnresolvedTenants(
  ctx: ReprocessUnresolvedCtx,
): Promise<ReprocessResult> {
  const {
    pool,
    resolveMerchant,
    emitEvent,
    logger,
    metrics,
    minAgeSeconds = 30,
    maxRetries = 24,
  } = ctx;

  const result: ReprocessResult = { retried: 0, resolved: 0, abandoned: 0 };

  // Fetch candidates: unresolved, old enough, not yet exhausted
  const client = await pool.connect();
  let rows: UnresolvedEventRow[] = [];
  try {
    const qResult = await client.query<UnresolvedEventRow>(
      `SELECT viva_webhook_event_id, event_type_id, viva_merchant_id, connected_account_id,
              transaction_id, retry_count, raw_payload
         FROM viva_webhook_event
        WHERE processed_at IS NULL
          AND received_at < now() - make_interval(secs => $1)
          AND retry_count < $2
        ORDER BY received_at ASC
        LIMIT 100`,
      [minAgeSeconds, maxRetries],
    );
    rows = qResult.rows;
  } finally {
    client.release();
  }

  for (const row of rows) {
    result.retried++;

    let resolved: { tenantId: string } | null = null;
    try {
      resolved = await resolveMerchant(row.viva_merchant_id, row.connected_account_id);
    } catch (err) {
      logger.error(
        `[viva] reprocessUnresolvedTenants: resolveMerchant threw for eventId=${row.viva_webhook_event_id}: ` +
        `${err instanceof Error ? err.message : String(err)}`,
      );
    }

    if (resolved) {
      // Resolution succeeded — re-emit for subscriber processing
      result.resolved++;
      const updateClient = await pool.connect();
      try {
        await updateClient.query(
          `UPDATE viva_webhook_event SET retry_count = retry_count + 1 WHERE viva_webhook_event_id = $1`,
          [row.viva_webhook_event_id],
        );
      } finally {
        updateClient.release();
      }

      if (emitEvent) {
        await emitEvent('viva.webhook.received', {
          eventId: row.viva_webhook_event_id,
          tenantId: resolved.tenantId,
          eventTypeId: row.event_type_id,
          transactionId: row.transaction_id,
          vivaMerchantId: row.viva_merchant_id,
          connectedAccountId: row.connected_account_id,
        }).catch((err: unknown) => {
          logger.error(
            `[viva] reprocessUnresolvedTenants: emitEvent failed for eventId=${row.viva_webhook_event_id}: ` +
            `${err instanceof Error ? err.message : String(err)}`,
          );
        });
      }

      metrics?.counter('viva_tenant_resolution_retry_resolved_total', {
        event_type_id: String(row.event_type_id),
      });
    } else if (row.retry_count + 1 >= maxRetries) {
      // Exhausted retries — abandon
      result.abandoned++;
      const abandonClient = await pool.connect();
      try {
        await abandonClient.query(
          `UPDATE viva_webhook_event
              SET processed_at = now(), retry_count = retry_count + 1
            WHERE viva_webhook_event_id = $1`,
          [row.viva_webhook_event_id],
        );
      } finally {
        abandonClient.release();
      }

      logger.warn(
        `[viva] ABANDONED webhook event ${row.viva_webhook_event_id} after ${row.retry_count + 1} retries. ` +
        `viva_merchant_id=${row.viva_merchant_id ?? 'null'} eventTypeId=${row.event_type_id}. ` +
        `Metric: viva_tenant_resolution_abandoned_total`,
      );
      metrics?.counter('viva_tenant_resolution_abandoned_total', {
        event_type_id: String(row.event_type_id),
      });
    } else {
      // Still unresolved, not yet exhausted — bump retry_count
      const bumpClient = await pool.connect();
      try {
        await bumpClient.query(
          `UPDATE viva_webhook_event SET retry_count = retry_count + 1 WHERE viva_webhook_event_id = $1`,
          [row.viva_webhook_event_id],
        );
      } finally {
        bumpClient.release();
      }
    }
  }

  return result;
}
