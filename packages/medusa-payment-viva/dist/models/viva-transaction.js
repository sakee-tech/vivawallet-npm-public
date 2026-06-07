import { EntitySchema } from "@medusajs/framework/mikro-orm/core";
export const VivaTransactionSchema = new EntitySchema({
    name: "VivaTransaction",
    tableName: "viva_transaction",
    uniques: [
        {
            name: "viva_transaction_idempotency_key_uniq",
            properties: ["idempotency_key"],
        },
        {
            name: "viva_transaction_viva_order_code_uniq",
            properties: ["viva_order_code"],
        },
    ],
    indexes: [
        {
            name: "viva_transaction_medusa_payment_id_idx",
            properties: ["medusa_payment_id"],
        },
        {
            name: "viva_transaction_merchant_created_idx",
            properties: ["viva_merchant_id", "created_at"],
        },
    ],
    properties: {
        viva_transaction_id: {
            type: "string",
            columnType: "uuid",
            primary: true,
        },
        viva_order_code: {
            type: "bigint",
            columnType: "bigint",
            // Nullable per Migration_20260425000002_allow_null_order_code.
            // NULL until createOrder returns successfully (A4 write-pending-first).
            // @see references/viva-docs/md/isv-partner-program.txt:61 (A4)
            nullable: true,
        },
        medusa_payment_id: {
            type: "string",
            columnType: "text",
            nullable: false,
        },
        viva_merchant_id: {
            type: "string",
            columnType: "uuid",
            // Nullable per Migration_20260425000004_webhook_error_and_nullable_merchant.
            // Merchant-mode rows have no per-cart tenant merchant id.
            nullable: true,
        },
        status: {
            type: "string",
            columnType: "text",
            nullable: false,
        },
        claim_substate: {
            type: "string",
            columnType: "text",
            nullable: true,
        },
        amount_minor: {
            type: "bigint",
            columnType: "bigint",
            nullable: false,
        },
        refunded_amount_minor: {
            type: "bigint",
            columnType: "bigint",
            nullable: false,
            default: 0,
        },
        currency_code: {
            type: "string",
            columnType: "text",
            nullable: false,
        },
        idempotency_key: {
            type: "string",
            columnType: "text",
            nullable: false,
        },
        raw_payload: {
            type: "json",
            columnType: "jsonb",
            nullable: true,
        },
        created_at: {
            type: "Date",
            columnType: "timestamptz",
            nullable: false,
            defaultRaw: "now()",
        },
        updated_at: {
            type: "Date",
            columnType: "timestamptz",
            nullable: false,
            defaultRaw: "now()",
        },
    },
});
//# sourceMappingURL=viva-transaction.js.map