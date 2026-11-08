import { Migration } from "@medusajs/framework/mikro-orm/migrations";
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
export declare class Migration_20260425000002_allow_null_order_code extends Migration {
    up(): Promise<void>;
    down(): Promise<void>;
}
//# sourceMappingURL=Migration_20260425000002_allow_null_order_code.d.ts.map