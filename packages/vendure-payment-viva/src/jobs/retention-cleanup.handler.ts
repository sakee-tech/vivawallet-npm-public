/**
 * jobs/retention-cleanup.handler.ts — 90-day webhook event retention cleanup.
 *
 * Runs once per day via setInterval (lightest-weight option — no new dep).
 * Deletes `viva_webhook_event` rows where:
 *   processed_at < now() - INTERVAL '90 days'
 *
 * Rows with processed_at = NULL are NOT deleted regardless of age.
 *
 * Design note: Vendure's built-in session-cache cleanup uses a similar
 * setInterval-in-OnApplicationBootstrap pattern (see SessionCacheService).
 * We follow the same approach rather than introducing a scheduler dep.
 *
 * @see docs/plans/vendure-plugin-v0.md §"Webhook Design — 90-day retention cleanup"
 */

import { Injectable } from '@nestjs/common';
import type { OnApplicationBootstrap, OnApplicationShutdown } from '@nestjs/common';
import { Logger, TransactionalConnection } from '@vendure/core';
import { LessThan } from 'typeorm';
import { VivaWebhookEvent } from '../entities/viva-webhook-event.entity.js';
import { VIVA_LOG_CONTEXT, WEBHOOK_RETENTION_DAYS } from '../constants.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const RETENTION_MS = WEBHOOK_RETENTION_DAYS * 24 * 60 * 60 * 1_000;
const CLEANUP_INTERVAL_MS = 24 * 60 * 60 * 1_000; // 1 day

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

@Injectable()
export class RetentionCleanupHandler implements OnApplicationBootstrap, OnApplicationShutdown {
  private _timer: ReturnType<typeof setInterval> | undefined;

  constructor(private readonly connection: TransactionalConnection) {}

  onApplicationBootstrap(): void {
    // Run the first cleanup shortly after boot (10s delay to let DB settle)
    const firstRunDelay = setTimeout(() => {
      void this._runCleanup();
    }, 10_000);
    if (firstRunDelay.unref) firstRunDelay.unref();

    // Then run once per day
    this._timer = setInterval(() => {
      void this._runCleanup();
    }, CLEANUP_INTERVAL_MS);
    if (this._timer.unref) this._timer.unref();
  }

  onApplicationShutdown(): void {
    if (this._timer) {
      clearInterval(this._timer);
    }
  }

  /**
   * Delete processed webhook events older than 90 days.
   * Exposed for direct invocation from tests.
   */
  async runCleanup(): Promise<number> {
    return this._runCleanup();
  }

  private async _runCleanup(): Promise<number> {
    const cutoff = new Date(Date.now() - RETENTION_MS);
    try {
      const repo = this.connection.rawConnection.getRepository(VivaWebhookEvent);
      const result = await repo.delete({
        processedAt: LessThan(cutoff),
      });
      const deleted = result.affected ?? 0;
      if (deleted > 0) {
        Logger.info(
          `[RetentionCleanup] Deleted ${deleted} webhook event rows older than ${WEBHOOK_RETENTION_DAYS} days.`,
          VIVA_LOG_CONTEXT,
        );
      }
      return deleted;
    } catch (err) {
      Logger.warn(
        `[RetentionCleanup] Cleanup failed: ${err instanceof Error ? err.message : String(err)}`,
        VIVA_LOG_CONTEXT,
      );
      return 0;
    }
  }
}
