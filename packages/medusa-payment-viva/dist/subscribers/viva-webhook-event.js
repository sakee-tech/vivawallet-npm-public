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
import { Modules } from '@medusajs/framework/utils';
import pg from 'pg';
import { IsvHttpClient } from '@sakeetech/viva-payments-core/isv';
import { Payments } from '@sakeetech/viva-payments-core/payments';
import { VivaApiError } from '@sakeetech/viva-payments-core/errors';
import { buildAuthStrategies } from '../resolvers/auth-strategy-factory.js';
import { loadConfigFromEnv } from '../config.js';
import { processWebhookEvent, recordWebhookFailure } from '../workflows/process-webhook-event.js';
import { defaultSemaphore } from '../workflows/per-tenant-semaphore.js';
// ---------------------------------------------------------------------------
// Subscriber
// ---------------------------------------------------------------------------
export const config = {
    event: 'viva.webhook.received',
    context: {
        subscriberId: 'viva-webhook-event-subscriber',
    },
};
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
export async function vivaWebhookEventSubscriber({ event, container, }) {
    const data = event.data;
    if (!data?.eventId) {
        return;
    }
    const tenantKey = data.tenantId ?? '__unresolved__';
    // A11: acquire per-tenant semaphore slot (max 5 concurrent per tenant)
    const release = await defaultSemaphore.acquire(tenantKey);
    try {
        const logger = container.resolve('logger') ?? { info: () => undefined, warn: () => undefined, error: () => undefined };
        // Build pg pool for this request
        const connString = process.env['DATABASE_URL'] ??
            `postgresql://${process.env['USER'] ?? 'postgres'}@localhost:5432/postgres`;
        const pool = new pg.Pool({ connectionString: connString, max: 5 });
        try {
            // Fetch the full envelope from the DB (we stored raw_payload at ingest time)
            const client = await pool.connect();
            let envelope = null;
            try {
                const result = await client.query(`SELECT raw_payload FROM viva_webhook_event WHERE viva_webhook_event_id = $1`, [data.eventId]);
                envelope = result.rows[0]?.raw_payload ?? null;
            }
            finally {
                client.release();
            }
            if (!envelope) {
                logger.warn(`[viva] Subscriber: no envelope found for eventId=${data.eventId}. Skipping.`);
                return;
            }
            // Build Payments from config
            let isvPayments;
            let configMode = 'isv';
            try {
                const config = loadConfigFromEnv(process.env);
                configMode = config.mode;
                const authStrategies = buildAuthStrategies(config);
                const httpClient = new IsvHttpClient({
                    environment: config.environment,
                    authStrategy: authStrategies.primary,
                });
                isvPayments = new Payments({ mode: 'isv', client: httpClient });
            }
            catch {
                logger.warn(`[viva] Subscriber: could not load Viva config for eventId=${data.eventId}. Skipping.`);
                return;
            }
            await processWebhookEvent({
                eventId: data.eventId,
                eventTypeId: data.eventTypeId,
                envelope,
                tenantId: data.tenantId,
            }, {
                pool,
                isvPayments,
                logger,
                mode: configMode,
            });
        }
        catch (err) {
            // Record the failure envelope on viva_webhook_event.error + bump
            // retry_count so the operator playbook (docs/ERRORS.md §6) and the
            // reaper job can see why the event is stuck. Best-effort; failures
            // here are swallowed so they don't mask the original error.
            await recordWebhookFailure(pool, data.eventId, err);
            if (err instanceof VivaApiError) {
                // Let job runner retry on Viva API errors (retriable)
                logger.error(`[viva] Subscriber VivaApiError for eventId=${data.eventId}: ${err.message}. Rethrowing for retry.`);
                throw err;
            }
            throw err;
        }
        finally {
            await pool.end().catch(() => undefined);
        }
    }
    finally {
        release();
    }
}
// Suppress unused-variable warning — container.resolve(Modules.EVENT_BUS) is used
// indirectly via event emission in the route handler; keep the import for type safety.
void Modules;
//# sourceMappingURL=viva-webhook-event.js.map