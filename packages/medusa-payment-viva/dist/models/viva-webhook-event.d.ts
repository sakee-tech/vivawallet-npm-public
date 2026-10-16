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
export declare const VivaWebhookEventSchema: EntitySchema<VivaWebhookEvent, never>;
//# sourceMappingURL=viva-webhook-event.d.ts.map