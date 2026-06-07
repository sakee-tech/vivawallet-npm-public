import { EntitySchema } from "@medusajs/framework/mikro-orm/core";
export const VivaWebhookEventSchema = new EntitySchema({
    name: "VivaWebhookEvent",
    tableName: "viva_webhook_event",
    uniques: [
        {
            name: "viva_webhook_event_message_id_uniq",
            properties: ["message_id"],
        },
    ],
    indexes: [
        {
            // Partial unique on (transaction_id, event_type_id) WHERE transaction_id IS NOT NULL.
            // Cannot express partial indexes via EntitySchema — defined as raw expression.
            name: "viva_webhook_event_txn_type_uniq",
            expression: "CREATE UNIQUE INDEX IF NOT EXISTS viva_webhook_event_txn_type_uniq " +
                "ON viva_webhook_event (transaction_id, event_type_id) WHERE transaction_id IS NOT NULL",
        },
        {
            name: "viva_webhook_event_type_received_idx",
            properties: ["event_type_id", "received_at"],
        },
    ],
    properties: {
        viva_webhook_event_id: {
            type: "string",
            columnType: "uuid",
            primary: true,
            defaultRaw: "gen_random_uuid()",
        },
        transaction_id: {
            type: "string",
            columnType: "uuid",
            nullable: true,
        },
        event_type_id: {
            type: "number",
            columnType: "int",
            nullable: false,
        },
        message_id: {
            type: "string",
            columnType: "uuid",
            nullable: false,
        },
        viva_merchant_id: {
            type: "string",
            columnType: "uuid",
            nullable: true,
        },
        connected_account_id: {
            type: "string",
            columnType: "uuid",
            nullable: true,
        },
        processed_at: {
            type: "Date",
            columnType: "timestamptz",
            nullable: true,
        },
        raw_payload: {
            type: "json",
            columnType: "jsonb",
            nullable: false,
        },
        received_at: {
            type: "Date",
            columnType: "timestamptz",
            nullable: false,
            defaultRaw: "now()",
        },
        error: {
            type: "string",
            columnType: "text",
            nullable: true,
        },
        retry_count: {
            type: "number",
            columnType: "int",
            nullable: false,
            default: 0,
        },
    },
});
//# sourceMappingURL=viva-webhook-event.js.map