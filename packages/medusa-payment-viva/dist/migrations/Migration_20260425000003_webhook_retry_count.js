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
export class Migration_20260425000003_webhook_retry_count extends Migration {
    async up() {
        this.addSql(`
      ALTER TABLE viva_webhook_event
        ADD COLUMN IF NOT EXISTS retry_count int NOT NULL DEFAULT 0;
    `);
        // Index to make the reprocess query efficient:
        // SELECT ... WHERE processed_at IS NULL AND received_at < ... AND retry_count < ...
        this.addSql(`
      CREATE INDEX IF NOT EXISTS viva_webhook_event_unresolved_retry_idx
        ON viva_webhook_event (received_at, retry_count)
        WHERE processed_at IS NULL;
    `);
    }
    async down() {
        this.addSql(`
      DROP INDEX IF EXISTS viva_webhook_event_unresolved_retry_idx;
    `);
        this.addSql(`
      ALTER TABLE viva_webhook_event
        DROP COLUMN IF EXISTS retry_count;
    `);
    }
}
//# sourceMappingURL=Migration_20260425000003_webhook_retry_count.js.map