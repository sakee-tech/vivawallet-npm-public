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
/**
 * Retries per webhook job. Vendure's `JobQueue.add` defaults to 0, which made
 * every "throw so the job retries" path run once. The delay between tries is
 * the host queue's backoff (DefaultJobQueuePlugin: flat 1 s; BullMQ: exponential
 * from 1 s).
 */
export declare const VIVA_WEBHOOK_JOB_RETRIES = 10;
//# sourceMappingURL=queue-names.d.ts.map