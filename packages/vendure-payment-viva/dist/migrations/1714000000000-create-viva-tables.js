/**
 * 1714000000000-create-viva-tables.ts — Initial migration for Viva Wallet plugin tables.
 *
 * @see docs/plans/vendure-plugin-v0.md §"Data Model" + §"Migrations"
 *
 * Creates:
 *   - viva_transaction      — payment lifecycle tracking
 *   - viva_webhook_event    — webhook dedupe + audit log
 *
 * Column types match entity decorators exactly. Timestamps use
 * `timestamp with time zone` (UTC).
 *
 * Partial indexes (WHERE clauses) use raw SQL via queryRunner.query() because
 * TypeORM's createIndex API does not support WHERE predicates.
 */
import {} from 'typeorm';
export class CreateVivaTables1714000000000 {
    name = 'CreateVivaTables1714000000000';
    async up(queryRunner) {
        // -----------------------------------------------------------------------
        // viva_transaction
        // -----------------------------------------------------------------------
        await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "viva_transaction" (
        "id"                  uuid                     NOT NULL DEFAULT gen_random_uuid(),
        "channel_id"          integer                  NOT NULL,
        "payment_id"          integer                  NOT NULL,
        "viva_order_code"     character varying        DEFAULT NULL,
        "viva_transaction_id" character varying        DEFAULT NULL,
        "status"              character varying        NOT NULL,
        "amount_minor"        bigint                   NOT NULL,
        "currency_code"       character varying(3)     NOT NULL,
        "isv_amount_minor"    bigint                   NOT NULL DEFAULT 0,
        "metadata"            jsonb                    NOT NULL DEFAULT '{}',
        "created_at"          timestamp with time zone NOT NULL DEFAULT now(),
        "updated_at"          timestamp with time zone NOT NULL DEFAULT now(),
        CONSTRAINT "PK_viva_transaction" PRIMARY KEY ("id")
      )
    `);
        // Composite unique: one transaction row per (channel, payment).
        await queryRunner.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS "idx_viva_transaction_channel_payment"
        ON "viva_transaction" ("channel_id", "payment_id")
    `);
        // Partial unique: viva_order_code is unique only among non-NULL values
        // (two NULL rows are fine — they represent payments pre-redirect).
        await queryRunner.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS "idx_viva_transaction_order_code"
        ON "viva_transaction" ("viva_order_code")
        WHERE "viva_order_code" IS NOT NULL
    `);
        // Non-unique: channel-scoped order-code lookups + transaction-id lookups.
        await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "idx_viva_transaction_channel_order_code"
        ON "viva_transaction" ("channel_id", "viva_order_code")
    `);
        await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "idx_viva_transaction_transaction_id"
        ON "viva_transaction" ("viva_transaction_id")
    `);
        // -----------------------------------------------------------------------
        // viva_webhook_event
        // -----------------------------------------------------------------------
        await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "viva_webhook_event" (
        "message_id"      uuid                     NOT NULL,
        "event_type_id"   integer                  NOT NULL,
        "merchant_id"     uuid                     DEFAULT NULL,
        "transaction_id"  character varying        DEFAULT NULL,
        "account_id"      character varying        DEFAULT NULL,
        "correlation_id"  character varying        DEFAULT NULL,
        "retry_count"     integer                  NOT NULL DEFAULT 0,
        "payload"         jsonb                    NOT NULL,
        "received_at"     timestamp with time zone NOT NULL DEFAULT now(),
        "processed_at"    timestamp with time zone DEFAULT NULL,
        "error"           text                     DEFAULT NULL,
        CONSTRAINT "PK_viva_webhook_event" PRIMARY KEY ("message_id")
      )
    `);
        // Non-unique composite: merchant + event type queries (A6 re-walk, stats).
        await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "idx_viva_webhook_event_merchant_type"
        ON "viva_webhook_event" ("merchant_id", "event_type_id")
    `);
        // Partial index: efficient pending-event scan (WHERE processed_at IS NULL).
        // Raw SQL required — TypeORM createIndex API has no WHERE support.
        await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "idx_viva_webhook_event_pending_received"
        ON "viva_webhook_event" ("received_at")
        WHERE "processed_at" IS NULL
    `);
    }
    async down(queryRunner) {
        // Drop indexes before tables (some DBs require explicit drops).
        await queryRunner.query(`DROP INDEX IF EXISTS "idx_viva_webhook_event_pending_received"`);
        await queryRunner.query(`DROP INDEX IF EXISTS "idx_viva_webhook_event_merchant_type"`);
        await queryRunner.query(`DROP TABLE IF EXISTS "viva_webhook_event"`);
        await queryRunner.query(`DROP INDEX IF EXISTS "idx_viva_transaction_transaction_id"`);
        await queryRunner.query(`DROP INDEX IF EXISTS "idx_viva_transaction_channel_order_code"`);
        await queryRunner.query(`DROP INDEX IF EXISTS "idx_viva_transaction_order_code"`);
        await queryRunner.query(`DROP INDEX IF EXISTS "idx_viva_transaction_channel_payment"`);
        await queryRunner.query(`DROP TABLE IF EXISTS "viva_transaction"`);
    }
}
//# sourceMappingURL=1714000000000-create-viva-tables.js.map