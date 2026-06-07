import { Migration } from "@medusajs/framework/mikro-orm/migrations";
/**
 * Migration_20260425000004_webhook_error_and_nullable_merchant
 *
 * Phase 2 slice D — unifies the Medusa schema with Vendure for multi-mode v0.2.0.
 *
 *   1. viva_webhook_event.error (text, nullable) — last failure envelope (JSON);
 *      operator playbook in docs/ERRORS.md §6 reads this column to diagnose
 *      stuck payments. Vendure already has it.
 *   2. viva_transaction.viva_merchant_id — drop NOT NULL. Merchant-mode rows
 *      don't have a per-cart merchant id (the plugin operates a single account).
 *
 * Forward-safe:
 *   - Existing viva_webhook_event rows get error=NULL (no backfill needed).
 *   - viva_transaction.viva_merchant_id stays populated for existing rows.
 *
 * Reversible:
 *   - down() drops the error column. The viva_merchant_id NOT NULL constraint
 *     is restored ONLY if no rows currently have NULL — otherwise the migration
 *     aborts with a clear error so the operator can backfill before retry.
 *
 * @see docs/plans/multi-mode-v0.md §9.6.5 (schema migration spec)
 * @see docs/ERRORS.md §6 (operator playbook requires `error` column)
 */
export class Migration_20260425000004_webhook_error_and_nullable_merchant extends Migration {
    async up() {
        // ---- viva_webhook_event.error (nullable text) ----
        this.addSql(`
      ALTER TABLE viva_webhook_event
        ADD COLUMN IF NOT EXISTS error text;
    `);
        // ---- viva_transaction.viva_merchant_id → nullable ----
        this.addSql(`
      ALTER TABLE viva_transaction
        ALTER COLUMN viva_merchant_id DROP NOT NULL;
    `);
    }
    async down() {
        // Drop the error column (data loss for any recorded failures — log it).
        this.addSql(`
      ALTER TABLE viva_webhook_event
        DROP COLUMN IF EXISTS error;
    `);
        // Restore NOT NULL on viva_merchant_id. Guard against NULL rows: if any
        // exist (merchant-mode rows from v0.2.0+), the migration aborts cleanly.
        // Operators must backfill or delete those rows before downgrading.
        this.addSql(`
      DO $$
      DECLARE
        null_count int;
      BEGIN
        SELECT count(*) INTO null_count
          FROM viva_transaction
         WHERE viva_merchant_id IS NULL;
        IF null_count > 0 THEN
          RAISE EXCEPTION
            'Cannot restore NOT NULL on viva_transaction.viva_merchant_id: % rows have NULL. '
            'Backfill or delete those rows (merchant-mode rows from v0.2.0+) before downgrading.',
            null_count;
        END IF;
      END;
      $$;
    `);
        this.addSql(`
      ALTER TABLE viva_transaction
        ALTER COLUMN viva_merchant_id SET NOT NULL;
    `);
    }
}
//# sourceMappingURL=Migration_20260425000004_webhook_error_and_nullable_merchant.js.map