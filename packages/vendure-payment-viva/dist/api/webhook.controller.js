/**
 * api/webhook.controller.ts — Viva Wallet webhook receiver.
 *
 * Handles two routes:
 *
 *   GET  /viva/webhook  — URL-verification handshake (no auth gate).
 *                         Returns {"key":"<webhookVerificationKey>"} to prove
 *                         ownership to Viva at registration time.
 *
 *   POST /viva/webhook  — Receive Viva event.
 *                         1. IP allowlist check.
 *                         2. Parse + validate envelope.
 *                         3. INSERT-OR-IGNORE into viva_webhook_event.
 *                         4. Enqueue BullMQ job if newly inserted (dedup).
 *                         5. Always return 200 {"ok":true}.
 *
 * Latency target: <100ms server-side — no Viva API call in this path.
 *
 * @see docs/plans/vendure-plugin-v0.md §"Webhook Design — Receive flow"
 * @see docs/plans/vendure-plugin-v0.md §"Build Plan — V6"
 * @see docs/VENDURE-CONTRACT.MD §4 "Webhook receiver"
 */
var __decorate = (this && this.__decorate) || function (decorators, target, key, desc) {
    var c = arguments.length, r = c < 3 ? target : desc === null ? desc = Object.getOwnPropertyDescriptor(target, key) : desc, d;
    if (typeof Reflect === "object" && typeof Reflect.decorate === "function") r = Reflect.decorate(decorators, target, key, desc);
    else for (var i = decorators.length - 1; i >= 0; i--) if (d = decorators[i]) r = (c < 3 ? d(r) : c > 3 ? d(target, key, r) : d(target, key)) || r;
    return c > 3 && r && Object.defineProperty(target, key, r), r;
};
var __metadata = (this && this.__metadata) || function (k, v) {
    if (typeof Reflect === "object" && typeof Reflect.metadata === "function") return Reflect.metadata(k, v);
};
var __param = (this && this.__param) || function (paramIndex, decorator) {
    return function (target, key) { decorator(target, key, paramIndex); }
};
import { Controller, Get, Post, Req, Res, Inject, } from '@nestjs/common';
import { TransactionalConnection, Logger, JobQueueService, } from '@vendure/core';
import { VIVA_PLUGIN_OPTIONS, VIVA_LOG_CONTEXT } from '../constants.js';
import { VivaWebhookEvent } from '../entities/viva-webhook-event.entity.js';
import { isIpAllowed, getSourceIp } from '../util/ip-allowlist.js';
import { VIVA_PROCESS_EVENT_JOB, VIVA_WEBHOOK_QUEUE } from '../jobs/queue-names.js';
// ---------------------------------------------------------------------------
// Controller
// ---------------------------------------------------------------------------
let WebhookController = class WebhookController {
    options;
    connection;
    jobQueueService;
    /**
     * BullMQ job queue — created once in onModuleInit, reused per-request.
     * The actual processing logic is implemented in V7's job handler.
     */
    webhookQueue;
    constructor(options, connection, jobQueueService) {
        this.options = options;
        this.connection = connection;
        this.jobQueueService = jobQueueService;
    }
    async onModuleInit() {
        // Create the queue once at startup. V7 will register the process handler;
        // here we provide a no-op so the queue can be used for add() calls.
        this.webhookQueue = await this.jobQueueService.createQueue({
            name: VIVA_WEBHOOK_QUEUE,
            process: async (_job) => {
                // V7 implements the actual handler (process-viva-webhook.handler.ts).
                // This stub satisfies Vendure's queue registration requirement.
            },
        });
    }
    // -------------------------------------------------------------------------
    // GET /viva/webhook — URL-verification handshake
    // -------------------------------------------------------------------------
    /**
     * Viva calls this endpoint anonymously during webhook registration to verify
     * ownership of the URL. We return the verification key from plugin options.
     *
     * No auth gate — Viva calls this without credentials.
     * @see docs/VENDURE-CONTRACT.MD §4 (URL-verification handshake)
     */
    handleVerification(res) {
        const key = this.options.webhookVerificationKey;
        if (!key) {
            Logger.warn('webhookVerificationKey is not configured — returning 503. Set VIVA_WEBHOOK_VERIFICATION_KEY.', VIVA_LOG_CONTEXT);
            res.writeHead(503, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'webhook key not configured' }));
            return;
        }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ key }));
    }
    // -------------------------------------------------------------------------
    // POST /viva/webhook — Receive event
    // -------------------------------------------------------------------------
    /**
     * Main receive path:
     * 1. IP allowlist check → 403 if blocked.
     * 2. Envelope parse → 400 if malformed.
     * 3. INSERT-OR-IGNORE into viva_webhook_event.
     * 4. Enqueue job if newly inserted; skip if replay.
     * 5. Always 200 {"ok":true}.
     */
    async handleEvent(req, res) {
        // ------------------------------------------------------------------
        // 1. IP allowlist (CSO Finding #2)
        // ------------------------------------------------------------------
        // trustedProxyDepth tells the helper how many trailing X-Forwarded-For
        // hops are set by operator-controlled proxies; the leftmost (attacker-
        // controllable) entries are ignored.
        const sourceIp = getSourceIp(req, this.options.trustedProxyDepth ?? 0);
        const allowlist = this.options.webhookIpAllowlist;
        if (!isIpAllowed(sourceIp, allowlist)) {
            Logger.warn(`Webhook POST rejected: source IP ${sourceIp} not in allowlist.`, VIVA_LOG_CONTEXT);
            res.writeHead(403, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'forbidden' }));
            return;
        }
        // ------------------------------------------------------------------
        // 2. Parse envelope
        // ------------------------------------------------------------------
        const body = req.body;
        if (!body || typeof body.MessageId !== 'string' || !body.MessageId) {
            Logger.warn('Webhook POST: missing or invalid MessageId.', VIVA_LOG_CONTEXT);
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'malformed envelope' }));
            return;
        }
        if (typeof body.EventTypeId !== 'number' || !body.EventTypeId) {
            Logger.warn(`Webhook POST: missing or invalid EventTypeId for MessageId=${body.MessageId}.`, VIVA_LOG_CONTEXT);
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'malformed envelope' }));
            return;
        }
        const messageId = body.MessageId;
        const eventTypeId = body.EventTypeId;
        const eventData = (body.EventData ?? {});
        // ------------------------------------------------------------------
        // 3. INSERT-OR-IGNORE into viva_webhook_event
        // ------------------------------------------------------------------
        const repo = this.connection.rawConnection.getRepository(VivaWebhookEvent);
        const insertResult = await repo
            .createQueryBuilder()
            .insert()
            .into(VivaWebhookEvent)
            .values({
            messageId,
            eventTypeId,
            merchantId: eventData['MerchantId'] ?? null,
            transactionId: eventData['TransactionId'] ?? null,
            accountId: eventData['AccountId'] ?? null,
            correlationId: body.CorrelationId ?? null,
            retryCount: body.RetryCount ?? 0,
            // Cast to any: TypeORM's _QueryDeepPartialEntity doesn't accept
            // plain objects for jsonb columns — the value is serialised correctly
            // at the driver level.
            payload: body,
        })
            .orIgnore()
            .execute();
        const rowsInserted = insertResult.identifiers.length;
        // ------------------------------------------------------------------
        // 4. Deduplicate — already processed replay
        // ------------------------------------------------------------------
        if (rowsInserted === 0) {
            Logger.debug(`Webhook POST: duplicate MessageId=${messageId} (replay) — skipping enqueue.`, VIVA_LOG_CONTEXT);
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ ok: true }));
            return;
        }
        // ------------------------------------------------------------------
        // 5. Enqueue BullMQ job (resilient — 200 even if enqueue fails)
        // ------------------------------------------------------------------
        try {
            await this.webhookQueue.add({ messageId });
        }
        catch (err) {
            // Row is persisted; V7's worker can pick it up via reprocess logic (A6).
            Logger.warn(`Webhook POST: job enqueue failed for MessageId=${messageId}. Row persisted; worker will retry. Error: ${String(err)}`, VIVA_LOG_CONTEXT);
        }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true }));
    }
};
__decorate([
    Get(),
    __param(0, Res()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Function]),
    __metadata("design:returntype", void 0)
], WebhookController.prototype, "handleVerification", null);
__decorate([
    Post(),
    __param(0, Req()),
    __param(1, Res()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object, Function]),
    __metadata("design:returntype", Promise)
], WebhookController.prototype, "handleEvent", null);
WebhookController = __decorate([
    Controller('viva/webhook'),
    __param(0, Inject(VIVA_PLUGIN_OPTIONS)),
    __metadata("design:paramtypes", [Object, TransactionalConnection,
        JobQueueService])
], WebhookController);
export { WebhookController };
//# sourceMappingURL=webhook.controller.js.map