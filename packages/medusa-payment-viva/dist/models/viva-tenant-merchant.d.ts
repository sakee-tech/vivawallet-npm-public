import { EntitySchema } from "@medusajs/framework/mikro-orm/core";
export interface VivaTenantMerchant {
    tenant_id: string;
    connected_account_id: string;
    viva_merchant_id: string;
    verification_status: string;
    created_at: Date;
    updated_at: Date;
}
export declare const VivaTenantMerchantSchema: EntitySchema<VivaTenantMerchant, never>;
//# sourceMappingURL=viva-tenant-merchant.d.ts.map