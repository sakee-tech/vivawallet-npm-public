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
import { type ID, VendureEntity } from '@vendure/core';
export type VivaTransactionStatus = 'pending' | 'authorized' | 'captured' | 'refunded' | 'partially_refunded' | 'failed' | 'cancelled';
/**
 * Composite unique index on (channel_id, payment_id) — one Viva transaction row
 * per Vendure payment per channel.
 */
export declare class VivaTransaction extends VendureEntity {
    constructor(input?: Partial<VivaTransaction>);
    /**
     * Vendure Channel ID. Column type resolved by EntityIdStrategy at boot.
     * Typically `int` (AutoIncrementIdStrategy) or `varchar(36)` (UuidIdStrategy).
     */
    channelId: ID;
    /**
     * Vendure Payment ID. Column type resolved by EntityIdStrategy at boot.
     */
    paymentId: ID;
    /**
     * Viva-side order code (numeric string). Nullable until `createPayment`
     * receives the response from `POST /checkout/v2/isv/orders`.
     */
    vivaOrderCode: string | null;
    /**
     * Viva-side transaction ID. Populated after webhook 1796 + Retrieve-Transaction.
     */
    vivaTransactionId: string | null;
    /**
     * Payment lifecycle status. Stored as varchar — no Postgres enum DDL.
     */
    status: VivaTransactionStatus;
    /**
     * Order amount in minor units (e.g. pence for GBP).
     * TypeORM returns bigint columns as strings — coerce with Number() / BigInt() in
     * service layer.
     */
    amountMinor: string;
    /**
     * ISO 4217 currency code stored as 3-char string (e.g. 'GBP').
     * Viva sends numeric currency codes outbound; we store the alpha code.
     */
    currencyCode: string;
    /**
     * ISV fee amount in minor units. Default 0. Must be < amountMinor (guarded in
     * createPayment handler).
     */
    isvAmountMinor: string;
    /**
     * Free-form metadata bag (redirect URL, idempotency key, Viva error details,
     * etc). Stored as jsonb.
     */
    metadata: Record<string, unknown>;
}
//# sourceMappingURL=viva-transaction.entity.d.ts.map