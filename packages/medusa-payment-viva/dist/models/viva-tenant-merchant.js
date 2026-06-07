import { EntitySchema } from "@medusajs/framework/mikro-orm/core";
export const VivaTenantMerchantSchema = new EntitySchema({
    name: "VivaTenantMerchant",
    tableName: "viva_tenant_merchant",
    uniques: [
        {
            name: "viva_tenant_merchant_viva_merchant_id_uniq",
            properties: ["viva_merchant_id"],
        },
        {
            name: "viva_tenant_merchant_connected_account_id_uniq",
            properties: ["connected_account_id"],
        },
    ],
    properties: {
        tenant_id: {
            type: "string",
            columnType: "text",
            primary: true,
        },
        connected_account_id: {
            type: "string",
            columnType: "uuid",
            nullable: false,
        },
        viva_merchant_id: {
            type: "string",
            columnType: "uuid",
            nullable: false,
        },
        verification_status: {
            type: "string",
            columnType: "text",
            nullable: false,
            default: "pending",
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
//# sourceMappingURL=viva-tenant-merchant.js.map