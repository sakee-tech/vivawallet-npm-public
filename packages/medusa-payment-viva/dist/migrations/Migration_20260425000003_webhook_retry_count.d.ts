import { Migration } from "@medusajs/framework/mikro-orm/migrations";
/**
 * Migration_20260425000003_webhook_retry_count
 *
 * A6: adds `retry_count int NOT NULL DEFAULT 0` to `viva_webhook_event`.
 * Required by `reprocessUnresolvedTenants` to track how many times tenant
 * resolution has been attempted for unresolved webhook events.
 *
 * up():   ADD COLUMN retry_count int NOT NULL DEFAULT 0.
 * down(): DROP COLUMN retry_count.
 *
 * @see references/viva-docs/md/isv-partner-program.txt:61 (A6 tenant fallback + reprocess)
 */
export declare class Migration_20260425000003_webhook_retry_count extends Migration {
    up(): Promise<void>;
    down(): Promise<void>;
}
//# sourceMappingURL=Migration_20260425000003_webhook_retry_count.d.ts.map