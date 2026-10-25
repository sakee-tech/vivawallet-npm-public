import { Migration } from "@medusajs/framework/mikro-orm/migrations";
/**
 * S7 — initial migration: creates all three plugin-owned tables atomically.
 *
 * up()   — CREATE TABLE IF NOT EXISTS + indexes (idempotent).
 * down() — Attempts COPY of viva_webhook_event raw_payload to /tmp before drop
 *          for forensic preservation per plan line 205.
 *          NOTE: COPY TO file requires the postgres superuser role. If the
 *          migration runner connects as a non-superuser, this COPY will fail.
 *          In that case, wrap the COPY in a DO block that catches the error and
 *          logs a notice — data preservation is best-effort in non-superuser
 *          deployments. Operators should take a pg_dump backup before running
 *          down() in production.
 */
export declare class Migration_20260425000001_init_viva_payments extends Migration {
    up(): Promise<void>;
    down(): Promise<void>;
}
//# sourceMappingURL=Migration_20260425000001_init_viva_payments.d.ts.map