"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.Migration_20260425000002_allow_null_order_code = void 0;
const migrations_1 = require("@medusajs/framework/mikro-orm/migrations");
/**
 * Migration_20260425000002_allow_null_order_code
 *
 * Write-pending-first (A4): makes viva_transaction.viva_order_code nullable
 * so the plugin can INSERT a pending row BEFORE calling Viva's createOrder API.
 *
 * Rationale: the A4 amendment requires that a local DB record exists before any
 * outbound HTTP call. If createOrder fails after INSERT, the row stays at
 * status='initiated' with viva_order_code=NULL. A reaper job (S10/S11) will
 * retry or expire these stuck rows. The alternative (NOT NULL DEFAULT 0) would
 * require app-level enforcement that 0 means "not yet assigned", which is
 * error-prone and not semantically clean.
 *
 * Decision: chose nullable over DEFAULT 0 because NULL is semantically honest —
 * an absent order code is not the same as order code 0.
 *
 * The UNIQUE index on viva_order_code uses a partial index (WHERE viva_order_code
 * IS NOT NULL) to allow multiple NULL rows without violating the constraint.
 * Multiple in-flight pending rows (each with NULL order_code) are valid as long
 * as their idempotency_key is unique — the idempotency_key UNIQUE index covers
 * the dedup requirement.
 *
 * up():   ALTER COLUMN → nullable; recreate unique index as partial.
 * down(): backfill NULLs to 0; ALTER COLUMN → NOT NULL.
 */
class Migration_20260425000002_allow_null_order_code extends migrations_1.Migration {
    async up() {
        // 1. Drop the existing non-partial unique index on viva_order_code
        this.addSql(`
      DROP INDEX IF EXISTS viva_transaction_viva_order_code_uniq;
    `);
        // 2. Make viva_order_code nullable
        this.addSql(`
      ALTER TABLE viva_transaction
        ALTER COLUMN viva_order_code DROP NOT NULL;
    `);
        // 3. Recreate as partial unique index (NULL values are excluded)
        this.addSql(`
      CREATE UNIQUE INDEX IF NOT EXISTS viva_transaction_viva_order_code_uniq
        ON viva_transaction (viva_order_code)
        WHERE viva_order_code IS NOT NULL;
    `);
    }
    async down() {
        // Backfill any NULL viva_order_code rows to 0 before restoring NOT NULL.
        // 0 is not a valid Viva order code, so operators can identify affected rows.
        this.addSql(`
      UPDATE viva_transaction SET viva_order_code = 0 WHERE viva_order_code IS NULL;
    `);
        // Drop partial unique index
        this.addSql(`
      DROP INDEX IF EXISTS viva_transaction_viva_order_code_uniq;
    `);
        // Restore NOT NULL constraint
        this.addSql(`
      ALTER TABLE viva_transaction
        ALTER COLUMN viva_order_code SET NOT NULL;
    `);
        // Recreate original non-partial unique index
        this.addSql(`
      CREATE UNIQUE INDEX IF NOT EXISTS viva_transaction_viva_order_code_uniq
        ON viva_transaction (viva_order_code);
    `);
    }
}
exports.Migration_20260425000002_allow_null_order_code = Migration_20260425000002_allow_null_order_code;
//# sourceMappingURL=Migration_20260425000002_allow_null_order_code.js.map