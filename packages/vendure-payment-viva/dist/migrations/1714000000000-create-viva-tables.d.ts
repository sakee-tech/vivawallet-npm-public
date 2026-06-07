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
import { type MigrationInterface, type QueryRunner } from 'typeorm';
export declare class CreateVivaTables1714000000000 implements MigrationInterface {
    name: string;
    up(queryRunner: QueryRunner): Promise<void>;
    down(queryRunner: QueryRunner): Promise<void>;
}
//# sourceMappingURL=1714000000000-create-viva-tables.d.ts.map