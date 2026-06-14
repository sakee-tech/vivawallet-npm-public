/**
 * api/webhook.controller.ts — Viva Wallet webhook receiver.
 *
 * Handles two routes:
 *
 *   GET  /viva/webhook  — URL-verification handshake (no auth gate).
 *                         Returns {"Key":"<webhookVerificationKey>"} to prove
 *                         ownership to Viva at registration time (capital `Key`
 *                         per the documented response shape).
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
import type { OnModuleInit } from '@nestjs/common';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { TransactionalConnection, JobQueueService } from '@vendure/core';
import type { VivaPaymentPluginOptions } from '../types.js';
export declare class WebhookController implements OnModuleInit {
    private readonly options;
    private readonly connection;
    private readonly jobQueueService;
    /**
     * BullMQ job queue — created once in onModuleInit, reused per-request.
     * The actual processing logic is implemented in V7's job handler.
     */
    private webhookQueue;
    constructor(options: VivaPaymentPluginOptions, connection: TransactionalConnection, jobQueueService: JobQueueService);
    onModuleInit(): Promise<void>;
    /**
     * Viva calls this endpoint anonymously during webhook registration to verify
     * ownership of the URL. We return the verification key from plugin options.
     *
     * No auth gate — Viva calls this without credentials.
     * @see docs/VENDURE-CONTRACT.MD §4 (URL-verification handshake)
     */
    handleVerification(res: ServerResponse): void;
    /**
     * Main receive path:
     * 1. IP allowlist check → 403 if blocked.
     * 2. Envelope parse → 400 if malformed.
     * 3. INSERT-OR-IGNORE into viva_webhook_event.
     * 4. Enqueue job if newly inserted; skip if replay.
     * 5. Always 200 {"ok":true}.
     */
    handleEvent(req: IncomingMessage & {
        body?: unknown;
    }, res: ServerResponse): Promise<void>;
}
//# sourceMappingURL=webhook.controller.d.ts.map