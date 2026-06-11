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
/** Non-unique composite index for merchant-scoped event type queries. */
export declare class VivaWebhookEvent {
    constructor(input?: Partial<VivaWebhookEvent>);
    /**
     * Envelope MessageId from Viva. UUIDv4. Natural primary key + dedupe key.
     * INSERT-OR-IGNORE on conflict prevents double-processing.
     */
    messageId: string;
    /**
     * Viva event type code (1796, 1797, 1798, 4865, 8193, 8194, …).
     */
    eventTypeId: number;
    /**
     * Viva merchantId UUID from EventData.MerchantId. Nullable — absent for some
     * event types and set to NULL on A6 unresolvable-channel fallback.
     */
    merchantId: string | null;
    /**
     * Viva TransactionId from EventData.TransactionId. Applicable to payment events.
     */
    transactionId: string | null;
    /**
     * Viva AccountId from EventData.AccountId. Applicable to onboarding events
     * (8193, 8194).
     */
    accountId: string | null;
    /**
     * Correlation ID for distributed tracing (if present in event envelope).
     */
    correlationId: string | null;
    /**
     * Number of processing attempts. Incremented on each BullMQ retry.
     */
    retryCount: number;
    /**
     * Raw event payload. Stored as jsonb for querying EventData fields without
     * schema migration.
     */
    payload: Record<string, unknown>;
    /**
     * Wall-clock time the POST /viva/webhook request was received.
     * Partial index on this column WHERE processed_at IS NULL — see migration.
     */
    receivedAt: Date;
    /**
     * Set when the BullMQ job completes successfully. NULL = pending/failed.
     */
    processedAt: Date | null;
    /**
     * Last processing failure reason. Populated on job error; cleared on success.
     */
    error: string | null;
}
//# sourceMappingURL=viva-webhook-event.entity.d.ts.map