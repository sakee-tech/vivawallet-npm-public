/**
 * viva-webhook-event.entity.ts — TypeORM entity for incoming Viva Wallet webhook events.
 *
 * @see docs/plans/vendure-plugin-v0.md §"Data Model" lines 148-161
 *
 * Design notes:
 * - `messageId` is the primary key (envelope UUID). NOT auto-generated — Viva
 *   supplies it; we use it as the dedupe key (INSERT-OR-IGNORE on conflict).
 * - Does NOT extend VendureEntity — Vendure's base entity adds a generated
 *   auto-increment/uuid `id` which conflicts with our natural PK design. We use
 *   plain TypeORM `@PrimaryColumn` instead.
 * - Partial index on `(received_at) WHERE processed_at IS NULL` is declared as a
 *   standard @Index here for documentation; the WHERE clause requires raw SQL in
 *   the migration.
 * - Composite non-unique index on `(merchant_id, event_type_id)` supports
 *   efficient A6 NULL-merchant re-walk queries.
 */

import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryColumn,
} from 'typeorm';

// ---------------------------------------------------------------------------
// Entity
// ---------------------------------------------------------------------------

/** Non-unique composite index for merchant-scoped event type queries. */
@Index('idx_viva_webhook_event_merchant_type', ['merchantId', 'eventTypeId'])
@Entity('viva_webhook_event')
export class VivaWebhookEvent {
  constructor(input?: Partial<VivaWebhookEvent>) {
    if (input) {
      Object.assign(this, input);
    }
  }

  /**
   * Envelope MessageId from Viva. UUIDv4. Natural primary key + dedupe key.
   * INSERT-OR-IGNORE on conflict prevents double-processing.
   */
  @PrimaryColumn({ type: 'uuid', name: 'message_id' })
  messageId!: string;

  /**
   * Viva event type code (1796, 1797, 1798, 4865, 8193, 8194, …).
   */
  @Column({ type: 'int', name: 'event_type_id' })
  eventTypeId!: number;

  /**
   * Viva merchantId UUID from EventData.MerchantId. Nullable — absent for some
   * event types and set to NULL on A6 unresolvable-channel fallback.
   */
  @Column({ type: 'uuid', nullable: true, name: 'merchant_id' })
  merchantId!: string | null;

  /**
   * Viva TransactionId from EventData.TransactionId. Applicable to payment events.
   */
  @Column({ type: 'varchar', nullable: true, name: 'transaction_id' })
  transactionId!: string | null;

  /**
   * Viva connected-account id from EventData.ConnectedAccountId. Applicable to
   * onboarding events (8193, 8194). (Viva has no `AccountId` field — the
   * column name `account_id` is local.)
   */
  @Column({ type: 'varchar', nullable: true, name: 'account_id' })
  accountId!: string | null;

  /**
   * Correlation ID for distributed tracing (if present in event envelope).
   */
  @Column({ type: 'varchar', nullable: true, name: 'correlation_id' })
  correlationId!: string | null;

  /**
   * Number of processing attempts. Incremented on each BullMQ retry.
   */
  @Column({ type: 'int', default: 0, name: 'retry_count' })
  retryCount!: number;

  /**
   * Raw event payload. Stored as jsonb for querying EventData fields without
   * schema migration.
   */
  @Column({ type: 'jsonb', name: 'payload' })
  payload!: Record<string, unknown>;

  /**
   * Wall-clock time the POST /viva/webhook request was received.
   * Partial index on this column WHERE processed_at IS NULL — see migration.
   */
  @CreateDateColumn({ name: 'received_at', type: 'timestamp with time zone' })
  receivedAt!: Date;

  /**
   * Set when the BullMQ job completes successfully. NULL = pending/failed.
   */
  @Column({ type: 'timestamp with time zone', nullable: true, name: 'processed_at' })
  processedAt!: Date | null;

  /**
   * Last processing failure reason. Populated on job error; cleared on success.
   */
  @Column({ type: 'text', nullable: true, name: 'error' })
  error!: string | null;
}
