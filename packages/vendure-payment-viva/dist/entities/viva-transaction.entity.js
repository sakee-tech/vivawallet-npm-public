"use strict";
/**
 * viva-transaction.entity.ts — TypeORM entity for Viva Wallet payment transactions.
 *
 * @see docs/plans/vendure-plugin-v0.md §"Data Model" lines 132-146
 *
 * Design notes:
 * - Extends VendureEntity for Vendure-compatible `id` / `createdAt` / `updatedAt`.
 * - `channelId` and `paymentId` use `@EntityId()` — Vendure resolves the column
 *   type at boot via its EntityIdStrategy (int or uuid depending on config).
 * - `status` stored as varchar with TS literal union — avoids Postgres enum DDL
 *   migrations on value additions (matches Medusa convention).
 * - `amountMinor` and `isvAmountMinor` are bigint columns; TypeORM returns bigint
 *   as string — typed as `string`, coerce in service layer.
 * - Partial unique index on `vivaOrderCode WHERE viva_order_code IS NOT NULL` is
 *   declared here for documentation; the actual WHERE clause requires raw SQL in
 *   the migration (TypeORM decorator @Index doesn't support WHERE).
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
exports.VivaTransaction = void 0;
const typeorm_1 = require("typeorm");
const core_1 = require("@vendure/core");
// ---------------------------------------------------------------------------
// Entity
// ---------------------------------------------------------------------------
/**
 * Composite unique index on (channel_id, payment_id) — one Viva transaction row
 * per Vendure payment per channel.
 */
let VivaTransaction = class VivaTransaction extends core_1.VendureEntity {
    constructor(input) {
        super(input);
    }
    /**
     * Vendure Channel ID. Column type resolved by EntityIdStrategy at boot.
     * Typically `int` (AutoIncrementIdStrategy) or `varchar(36)` (UuidIdStrategy).
     */
    channelId;
    /**
     * Vendure Payment ID. Column type resolved by EntityIdStrategy at boot.
     */
    paymentId;
    /**
     * Viva-side order code (numeric string). Nullable until `createPayment`
     * receives the response from `POST /checkout/v2/isv/orders`.
     */
    vivaOrderCode;
    /**
     * Viva-side transaction ID. Populated after webhook 1796 + Retrieve-Transaction.
     */
    vivaTransactionId;
    /**
     * Payment lifecycle status. Stored as varchar — no Postgres enum DDL.
     */
    status;
    /**
     * Order amount in minor units (e.g. pence for GBP).
     * TypeORM returns bigint columns as strings — coerce with Number() / BigInt() in
     * service layer.
     */
    amountMinor;
    /**
     * ISO 4217 currency code stored as 3-char string (e.g. 'GBP').
     * Viva sends numeric currency codes outbound; we store the alpha code.
     */
    currencyCode;
    /**
     * ISV fee amount in minor units. Default 0. Must be < amountMinor (guarded in
     * createPayment handler).
     */
    isvAmountMinor;
    /**
     * Free-form metadata bag (redirect URL, idempotency key, Viva error details,
     * etc). Stored as jsonb.
     */
    metadata;
};
exports.VivaTransaction = VivaTransaction;
__decorate([
    (0, core_1.EntityId)(),
    __metadata("design:type", Object)
], VivaTransaction.prototype, "channelId", void 0);
__decorate([
    (0, core_1.EntityId)(),
    __metadata("design:type", Object)
], VivaTransaction.prototype, "paymentId", void 0);
__decorate([
    (0, typeorm_1.Column)({ type: 'varchar', nullable: true, name: 'viva_order_code' }),
    __metadata("design:type", Object)
], VivaTransaction.prototype, "vivaOrderCode", void 0);
__decorate([
    (0, typeorm_1.Column)({ type: 'varchar', nullable: true, name: 'viva_transaction_id' }),
    __metadata("design:type", Object)
], VivaTransaction.prototype, "vivaTransactionId", void 0);
__decorate([
    (0, typeorm_1.Column)({ type: 'varchar', name: 'status' }),
    __metadata("design:type", String)
], VivaTransaction.prototype, "status", void 0);
__decorate([
    (0, typeorm_1.Column)({ type: 'bigint', name: 'amount_minor' }),
    __metadata("design:type", String)
], VivaTransaction.prototype, "amountMinor", void 0);
__decorate([
    (0, typeorm_1.Column)({ type: 'varchar', length: 3, name: 'currency_code' }),
    __metadata("design:type", String)
], VivaTransaction.prototype, "currencyCode", void 0);
__decorate([
    (0, typeorm_1.Column)({ type: 'bigint', default: '0', name: 'isv_amount_minor' }),
    __metadata("design:type", String)
], VivaTransaction.prototype, "isvAmountMinor", void 0);
__decorate([
    (0, typeorm_1.Column)({ type: 'jsonb', default: '{}', name: 'metadata' }),
    __metadata("design:type", Object)
], VivaTransaction.prototype, "metadata", void 0);
exports.VivaTransaction = VivaTransaction = __decorate([
    (0, typeorm_1.Index)('idx_viva_transaction_channel_payment', ['channelId', 'paymentId'], { unique: true })
    /**
     * Partial unique on viva_order_code WHERE viva_order_code IS NOT NULL.
     * TypeORM decorator doesn't support WHERE; index created in raw SQL in migration.
     * Declared here for discoverability; has no runtime effect on index creation.
     */
    ,
    (0, typeorm_1.Index)('idx_viva_transaction_order_code', ['vivaOrderCode'], { unique: true }),
    (0, typeorm_1.Entity)('viva_transaction'),
    __metadata("design:paramtypes", [Object])
], VivaTransaction);
//# sourceMappingURL=viva-transaction.entity.js.map