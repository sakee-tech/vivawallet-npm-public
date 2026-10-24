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
import type { OnApplicationBootstrap, OnApplicationShutdown } from '@nestjs/common';
import { TransactionalConnection } from '@vendure/core';
export declare class RetentionCleanupHandler implements OnApplicationBootstrap, OnApplicationShutdown {
    private readonly connection;
    private _timer;
    constructor(connection: TransactionalConnection);
    onApplicationBootstrap(): void;
    onApplicationShutdown(): void;
    /**
     * Delete processed webhook events older than 90 days.
     * Exposed for direct invocation from tests.
     */
    runCleanup(): Promise<number>;
    private _runCleanup;
}
//# sourceMappingURL=retention-cleanup.handler.d.ts.map