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
export class Migration_20260425000001_init_viva_payments extends Migration {
    async up() {
        // Require gen_random_uuid() for viva_webhook_event PK default.
        this.addSql(`CREATE EXTENSION IF NOT EXISTS pgcrypto;`);
        // ------------------------------------------------------------------ --
        // Table: viva_tenant_merchant
        // ------------------------------------------------------------------ --
        this.addSql(`
      CREATE TABLE IF NOT EXISTS viva_tenant_merchant (
        tenant_id             text        PRIMARY KEY,
        connected_account_id  uuid        NOT NULL,
        viva_merchant_id      uuid        NOT NULL,
        verification_status   text        NOT NULL DEFAULT 'pending',
        created_at            timestamptz NOT NULL DEFAULT now(),
        updated_at            timestamptz NOT NULL DEFAULT now()
      );
    `);
        this.addSql(`
      CREATE UNIQUE INDEX IF NOT EXISTS viva_tenant_merchant_viva_merchant_id_uniq
        ON viva_tenant_merchant (viva_merchant_id);
    `);
        this.addSql(`
      CREATE UNIQUE INDEX IF NOT EXISTS viva_tenant_merchant_connected_account_id_uniq
        ON viva_tenant_merchant (connected_account_id);
    `);
        // ------------------------------------------------------------------ --
        // Table: viva_transaction
        // ------------------------------------------------------------------ --
        this.addSql(`
      CREATE TABLE IF NOT EXISTS viva_transaction (
        viva_transaction_id   uuid        PRIMARY KEY,
        viva_order_code       bigint      NOT NULL,
        medusa_payment_id     text        NOT NULL,
        viva_merchant_id      uuid        NOT NULL,
        status                text        NOT NULL CHECK (status IN (
          'initiated','authorized','captured','refunded','cancelled','failed','disputed'
        )),
        claim_substate        text,
        amount_minor          bigint      NOT NULL,
        refunded_amount_minor bigint      NOT NULL DEFAULT 0,
        currency_code         text        NOT NULL,
        idempotency_key       text        NOT NULL,
        raw_payload           jsonb,
        created_at            timestamptz NOT NULL DEFAULT now(),
        updated_at            timestamptz NOT NULL DEFAULT now()
      );
    `);
        this.addSql(`
      CREATE UNIQUE INDEX IF NOT EXISTS viva_transaction_idempotency_key_uniq
        ON viva_transaction (idempotency_key);
    `);
        this.addSql(`
      CREATE UNIQUE INDEX IF NOT EXISTS viva_transaction_viva_order_code_uniq
        ON viva_transaction (viva_order_code);
    `);
        this.addSql(`
      CREATE INDEX IF NOT EXISTS viva_transaction_medusa_payment_id_idx
        ON viva_transaction (medusa_payment_id);
    `);
        this.addSql(`
      CREATE INDEX IF NOT EXISTS viva_transaction_merchant_created_idx
        ON viva_transaction (viva_merchant_id, created_at);
    `);
        // ------------------------------------------------------------------ --
        // Table: viva_webhook_event
        // ------------------------------------------------------------------ --
        this.addSql(`
      CREATE TABLE IF NOT EXISTS viva_webhook_event (
        viva_webhook_event_id uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
        transaction_id        uuid,
        event_type_id         int         NOT NULL,
        message_id            uuid        NOT NULL,
        viva_merchant_id      uuid,
        connected_account_id  uuid,
        processed_at          timestamptz,
        raw_payload           jsonb       NOT NULL,
        received_at           timestamptz NOT NULL DEFAULT now()
      );
    `);
        // Partial unique: one event_type_id per transaction (dedup), only when
        // transaction_id IS NOT NULL (onboarding events have NULL transaction_id).
        this.addSql(`
      CREATE UNIQUE INDEX IF NOT EXISTS viva_webhook_event_txn_type_uniq
        ON viva_webhook_event (transaction_id, event_type_id)
        WHERE transaction_id IS NOT NULL;
    `);
        this.addSql(`
      CREATE UNIQUE INDEX IF NOT EXISTS viva_webhook_event_message_id_uniq
        ON viva_webhook_event (message_id);
    `);
        this.addSql(`
      CREATE INDEX IF NOT EXISTS viva_webhook_event_type_received_idx
        ON viva_webhook_event (event_type_id, received_at);
    `);
    }
    async down() {
        // Best-effort: export raw_payload rows to /tmp before drop.
        // COPY TO requires pg superuser. Wrapped in a DO block so non-superuser
        // deployments degrade gracefully (notice logged, drop proceeds).
        // TODO(ops): run pg_dump before down() in production.
        const exportTs = new Date().toISOString().replace(/[^0-9]/g, "").slice(0, 14);
        this.addSql(`
      DO $$
      BEGIN
        COPY (SELECT * FROM viva_webhook_event)
          TO '/tmp/viva_webhook_event_${exportTs}.json';
        RAISE NOTICE 'viva_webhook_event exported to /tmp/viva_webhook_event_${exportTs}.json';
      EXCEPTION WHEN insufficient_privilege THEN
        RAISE NOTICE 'COPY skipped (insufficient privilege) — backup viva_webhook_event manually before drop.';
      END;
      $$;
    `);
        this.addSql(`DROP TABLE IF EXISTS viva_webhook_event;`);
        this.addSql(`DROP TABLE IF EXISTS viva_transaction;`);
        this.addSql(`DROP TABLE IF EXISTS viva_tenant_merchant;`);
    }
}
//# sourceMappingURL=Migration_20260425000001_init_viva_payments.js.map