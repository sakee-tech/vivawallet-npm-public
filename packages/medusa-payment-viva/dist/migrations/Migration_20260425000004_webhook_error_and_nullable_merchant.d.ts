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
export declare class Migration_20260425000004_webhook_error_and_nullable_merchant extends Migration {
    up(): Promise<void>;
    down(): Promise<void>;
}
//# sourceMappingURL=Migration_20260425000004_webhook_error_and_nullable_merchant.d.ts.map