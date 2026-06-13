/**
 * jobs/queue-names.ts — Single source of truth for BullMQ queue + job names.
 *
 * Both the webhook controller (V6) and the webhook job handler (V7) import
 * from here so the strings are never duplicated.
 *
 * @see docs/plans/vendure-plugin-v0.md §"Build Plan — V6"
 */
/** BullMQ queue that receives all Viva webhook processing jobs. */
export declare const VIVA_WEBHOOK_QUEUE = "viva-webhook";
/** Job that processes a single Viva webhook event (V7 implements the handler). */
export declare const VIVA_PROCESS_EVENT_JOB = "process-viva-webhook";
/** Payload for the `process-viva-webhook` job. */
export interface ProcessVivaWebhookJobData {
    /** Envelope MessageId (UUID) — foreign key into `viva_webhook_event.message_id`. */
    messageId: string;
}
//# sourceMappingURL=queue-names.d.ts.map