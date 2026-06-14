"use strict";
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
var __decorate = (this && this.__decorate) || function (decorators, target, key, desc) {
    var c = arguments.length, r = c < 3 ? target : desc === null ? desc = Object.getOwnPropertyDescriptor(target, key) : desc, d;
    if (typeof Reflect === "object" && typeof Reflect.decorate === "function") r = Reflect.decorate(decorators, target, key, desc);
    else for (var i = decorators.length - 1; i >= 0; i--) if (d = decorators[i]) r = (c < 3 ? d(r) : c > 3 ? d(target, key, r) : d(target, key)) || r;
    return c > 3 && r && Object.defineProperty(target, key, r), r;
};
var __metadata = (this && this.__metadata) || function (k, v) {
    if (typeof Reflect === "object" && typeof Reflect.metadata === "function") return Reflect.metadata(k, v);
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.VivaWebhookEvent = void 0;
const typeorm_1 = require("typeorm");
// ---------------------------------------------------------------------------
// Entity
// ---------------------------------------------------------------------------
/** Non-unique composite index for merchant-scoped event type queries. */
let VivaWebhookEvent = class VivaWebhookEvent {
    constructor(input) {
        if (input) {
            Object.assign(this, input);
        }
    }
    /**
     * Envelope MessageId from Viva. UUIDv4. Natural primary key + dedupe key.
     * INSERT-OR-IGNORE on conflict prevents double-processing.
     */
    messageId;
    /**
     * Viva event type code (1796, 1797, 1798, 4865, 8193, 8194, …).
     */
    eventTypeId;
    /**
     * Viva merchantId UUID from EventData.MerchantId. Nullable — absent for some
     * event types and set to NULL on A6 unresolvable-channel fallback.
     */
    merchantId;
    /**
     * Viva TransactionId from EventData.TransactionId. Applicable to payment events.
     */
    transactionId;
    /**
     * Viva connected-account id from EventData.ConnectedAccountId. Applicable to
     * onboarding events (8193, 8194). (Viva has no `AccountId` field — the
     * column name `account_id` is local.)
     */
    accountId;
    /**
     * Correlation ID for distributed tracing (if present in event envelope).
     */
    correlationId;
    /**
     * Number of processing attempts. Incremented on each BullMQ retry.
     */
    retryCount;
    /**
     * Raw event payload. Stored as jsonb for querying EventData fields without
     * schema migration.
     */
    payload;
    /**
     * Wall-clock time the POST /viva/webhook request was received.
     * Partial index on this column WHERE processed_at IS NULL — see migration.
     */
    receivedAt;
    /**
     * Set when the BullMQ job completes successfully. NULL = pending/failed.
     */
    processedAt;
    /**
     * Last processing failure reason. Populated on job error; cleared on success.
     */
    error;
};
exports.VivaWebhookEvent = VivaWebhookEvent;
__decorate([
    (0, typeorm_1.PrimaryColumn)({ type: 'uuid', name: 'message_id' }),
    __metadata("design:type", String)
], VivaWebhookEvent.prototype, "messageId", void 0);
__decorate([
    (0, typeorm_1.Column)({ type: 'int', name: 'event_type_id' }),
    __metadata("design:type", Number)
], VivaWebhookEvent.prototype, "eventTypeId", void 0);
__decorate([
    (0, typeorm_1.Column)({ type: 'uuid', nullable: true, name: 'merchant_id' }),
    __metadata("design:type", Object)
], VivaWebhookEvent.prototype, "merchantId", void 0);
__decorate([
    (0, typeorm_1.Column)({ type: 'varchar', nullable: true, name: 'transaction_id' }),
    __metadata("design:type", Object)
], VivaWebhookEvent.prototype, "transactionId", void 0);
__decorate([
    (0, typeorm_1.Column)({ type: 'varchar', nullable: true, name: 'account_id' }),
    __metadata("design:type", Object)
], VivaWebhookEvent.prototype, "accountId", void 0);
__decorate([
    (0, typeorm_1.Column)({ type: 'varchar', nullable: true, name: 'correlation_id' }),
    __metadata("design:type", Object)
], VivaWebhookEvent.prototype, "correlationId", void 0);
__decorate([
    (0, typeorm_1.Column)({ type: 'int', default: 0, name: 'retry_count' }),
    __metadata("design:type", Number)
], VivaWebhookEvent.prototype, "retryCount", void 0);
__decorate([
    (0, typeorm_1.Column)({ type: 'jsonb', name: 'payload' }),
    __metadata("design:type", Object)
], VivaWebhookEvent.prototype, "payload", void 0);
__decorate([
    (0, typeorm_1.CreateDateColumn)({ name: 'received_at', type: 'timestamp with time zone' }),
    __metadata("design:type", Date)
], VivaWebhookEvent.prototype, "receivedAt", void 0);
__decorate([
    (0, typeorm_1.Column)({ type: 'timestamp with time zone', nullable: true, name: 'processed_at' }),
    __metadata("design:type", Object)
], VivaWebhookEvent.prototype, "processedAt", void 0);
__decorate([
    (0, typeorm_1.Column)({ type: 'text', nullable: true, name: 'error' }),
    __metadata("design:type", Object)
], VivaWebhookEvent.prototype, "error", void 0);
exports.VivaWebhookEvent = VivaWebhookEvent = __decorate([
    (0, typeorm_1.Index)('idx_viva_webhook_event_merchant_type', ['merchantId', 'eventTypeId']),
    (0, typeorm_1.Entity)('viva_webhook_event'),
    __metadata("design:paramtypes", [Object])
], VivaWebhookEvent);
//# sourceMappingURL=viva-webhook-event.entity.js.map