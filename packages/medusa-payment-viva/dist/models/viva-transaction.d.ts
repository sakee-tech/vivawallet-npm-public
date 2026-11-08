import { EntitySchema } from "@medusajs/framework/mikro-orm/core";
export type VivaTransactionStatus = "initiated" | "authorized" | "captured" | "refunded" | "cancelled" | "failed" | "disputed";
export interface VivaTransaction {
    viva_transaction_id: string;
    /**
     * Viva order code (int64, stored as string for bigint safety).
     * NULL until viva createOrder returns successfully (A4 write-pending-first).
     * Migration_20260425000002 made this column nullable.
     *
     * @see references/viva-docs/md/payment-isv-api.txt:1 (createOrder response)
     * @see references/viva-docs/md/isv-partner-program.txt:61 (A4 write-pending-first)
     */
    viva_order_code: string | null | undefined;
    medusa_payment_id: string;
    /**
     * Viva merchant id (uuid). NULL for merchant-mode rows where there is no
     * per-cart tenant merchant id — the plugin operates a single account.
     * Migration_20260425000004 made this column nullable.
     *
     * @see references/viva-docs/md/isv-partner-program.txt:61 (multi-mode v0.2.0)
     */
    viva_merchant_id: string | null | undefined;
    status: VivaTransactionStatus;
    claim_substate: string | null | undefined;
    amount_minor: string;
    refunded_amount_minor: string;
    currency_code: string;
    idempotency_key: string;
    raw_payload: Record<string, unknown> | null | undefined;
    created_at: Date;
    updated_at: Date;
}
export declare const VivaTransactionSchema: EntitySchema<VivaTransaction, never>;
//# sourceMappingURL=viva-transaction.d.ts.map