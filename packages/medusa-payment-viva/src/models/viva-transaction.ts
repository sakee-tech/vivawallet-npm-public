import { EntitySchema } from "@medusajs/framework/mikro-orm/core";

export type VivaTransactionStatus =
  | "initiated"
  | "authorized"
  | "captured"
  | "refunded"
  | "cancelled"
  | "failed"
  | "disputed";

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
  // TODO(S6): verify bigint serialization at provider layer
  amount_minor: string;
  // TODO(S6): verify bigint serialization at provider layer
  refunded_amount_minor: string;
  currency_code: string;
  idempotency_key: string;
  raw_payload: Record<string, unknown> | null | undefined;
  created_at: Date;
  updated_at: Date;
}

export const VivaTransactionSchema = new EntitySchema<VivaTransaction>({
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
