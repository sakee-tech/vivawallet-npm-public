"use strict";
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
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.config = void 0;
exports.vivaWebhookEventSubscriber = vivaWebhookEventSubscriber;
const utils_1 = require("@medusajs/framework/utils");
const pg_1 = __importDefault(require("pg"));
const isv_1 = require("@sakeetech/viva-payments-core/isv");
const payments_1 = require("@sakeetech/viva-payments-core/payments");
const errors_1 = require("@sakeetech/viva-payments-core/errors");
const auth_strategy_factory_js_1 = require("../resolvers/auth-strategy-factory.js");
const config_js_1 = require("../config.js");
const process_webhook_event_js_1 = require("../workflows/process-webhook-event.js");
const per_tenant_semaphore_js_1 = require("../workflows/per-tenant-semaphore.js");
// ---------------------------------------------------------------------------
// Subscriber
// ---------------------------------------------------------------------------
exports.config = {
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
async function vivaWebhookEventSubscriber({ event, container, }) {
    const data = event.data;
    if (!data?.eventId) {
        return;
    }
    const tenantKey = data.tenantId ?? '__unresolved__';
    // A11: acquire per-tenant semaphore slot (max 5 concurrent per tenant)
    const release = await per_tenant_semaphore_js_1.defaultSemaphore.acquire(tenantKey);
    try {
        const logger = container.resolve('logger') ?? { info: () => undefined, warn: () => undefined, error: () => undefined };
        // Build pg pool for this request
        const connString = process.env['DATABASE_URL'] ??
            `postgresql://${process.env['USER'] ?? 'postgres'}@localhost:5432/postgres`;
        const pool = new pg_1.default.Pool({ connectionString: connString, max: 5 });
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
                const config = (0, config_js_1.loadConfigFromEnv)(process.env);
                configMode = config.mode;
                const authStrategies = (0, auth_strategy_factory_js_1.buildAuthStrategies)(config);
                const httpClient = new isv_1.IsvHttpClient({
                    environment: config.environment,
                    authStrategy: authStrategies.primary,
                });
                isvPayments = new payments_1.Payments({ mode: 'isv', client: httpClient });
            }
            catch {
                logger.warn(`[viva] Subscriber: could not load Viva config for eventId=${data.eventId}. Skipping.`);
                return;
            }
            await (0, process_webhook_event_js_1.processWebhookEvent)({
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
            await (0, process_webhook_event_js_1.recordWebhookFailure)(pool, data.eventId, err);
            if (err instanceof errors_1.VivaApiError) {
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
void utils_1.Modules;
//# sourceMappingURL=viva-webhook-event.js.map