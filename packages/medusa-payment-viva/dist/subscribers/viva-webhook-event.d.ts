/**
 * viva-webhook-event.ts — Medusa v2 subscriber for 'viva.webhook.received'.
 *
 * Listens to the event emitted by the webhook POST route handler after a
 * successful INSERT INTO viva_webhook_event (A2 gate: only fires when RETURNING
 * returned a row).
 *
 * Implements:
 *   - A11: per-tenant concurrency bounded to 5 via in-process PerTenantSemaphore.
 *   - A3: delegates to processWebhookEvent which uses fetch-then-lock pattern.
 *   - Error handling: VivaApiError triggers re-throw (job runner retries).
 *
 * @see references/viva-docs/md/isv-partner-program.txt:61 (A11 concurrency, A3 fetch-lock)
 */
import type { SubscriberArgs, SubscriberConfig } from '@medusajs/framework/subscribers';
interface VivaWebhookReceivedData {
    eventId: string;
    tenantId: string | null;
    eventTypeId: number;
    transactionId: string | null;
    vivaMerchantId: string | null;
    connectedAccountId: string | null;
}
export declare const config: SubscriberConfig;
/**
 * Subscriber for 'viva.webhook.received'.
 *
 * 1. Acquire per-tenant semaphore slot (A11: concurrency=5).
 * 2. Resolve the full webhook envelope from DB.
 * 3. Call processWebhookEvent (A3 fetch-then-lock).
 * 4. On VivaApiError: re-throw so the job runner retries with backoff.
 * 5. Release semaphore in finally.
 *
 * @see references/viva-docs/md/isv-partner-program.txt:61 (A11)
 */
export declare function vivaWebhookEventSubscriber({ event, container, }: SubscriberArgs<VivaWebhookReceivedData>): Promise<void>;
export {};
//# sourceMappingURL=viva-webhook-event.d.ts.map