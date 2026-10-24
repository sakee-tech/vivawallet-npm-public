import { EntitySchema } from "@medusajs/framework/mikro-orm/core";

export interface VivaWebhookEvent {
  viva_webhook_event_id: string;
  /** NULL for onboarding events */
  transaction_id: string | null | undefined;
  event_type_id: number;
  message_id: string;
  /** NULL for onboarding events */
  viva_merchant_id: string | null | undefined;
  /** NULL for non-onboarding events */
  connected_account_id: string | null | undefined;
  processed_at: Date | null | undefined;
  raw_payload: Record<string, unknown>;
  received_at: Date;
  /**
   * Last error envelope (JSON-serialized) recorded when processing failed.
   * NULL on success or before any failure. Operator playbook reads this to
   * diagnose stuck payments — see docs/ERRORS.md §6.
   *
   * Added by Migration_20260425000004_webhook_error_and_nullable_merchant.
   */
  error: string | null | undefined;
  /**
   * Count of processing/resolution attempts. Defaults to 0. Bumped on
   * tenant-resolution retries (A6) and on processing failures (job retry).
   *
   * Added by Migration_20260425000003_webhook_retry_count.
   */
  retry_count: number;
}

export const VivaWebhookEventSchema = new EntitySchema<VivaWebhookEvent>({
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
      expression:
        "CREATE UNIQUE INDEX IF NOT EXISTS viva_webhook_event_txn_type_uniq " +
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
