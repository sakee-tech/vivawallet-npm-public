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

import {
  Controller,
  Get,
  Post,
  Req,
  Res,
  Inject,
} from '@nestjs/common';
import type { OnModuleInit } from '@nestjs/common';
import type { IncomingMessage, ServerResponse } from 'node:http';
import {
  TransactionalConnection,
  Logger,
  JobQueueService,
} from '@vendure/core';
import type { JobQueue } from '@vendure/core';

import { VIVA_PLUGIN_OPTIONS, VIVA_LOG_CONTEXT } from '../constants.js';
import type { VivaPaymentPluginOptions } from '../types.js';
import { VivaWebhookEvent } from '../entities/viva-webhook-event.entity.js';
import { isIpAllowed, getSourceIp } from '../util/ip-allowlist.js';
import { VIVA_PROCESS_EVENT_JOB, VIVA_WEBHOOK_QUEUE } from '../jobs/queue-names.js';
import type { ProcessVivaWebhookJobData } from '../jobs/queue-names.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Shape of the top-level Viva webhook envelope. */
interface VivaWebhookEnvelope {
  MessageId?: string;
  EventTypeId?: number;
  CorrelationId?: string;
  RetryCount?: number;
  RetryDelayInSeconds?: number;
  EventData?: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Controller
// ---------------------------------------------------------------------------

@Controller('viva/webhook')
export class WebhookController implements OnModuleInit {
  /**
   * BullMQ job queue — created once in onModuleInit, reused per-request.
   * The actual processing logic is implemented in V7's job handler.
   */
  private webhookQueue!: JobQueue<ProcessVivaWebhookJobData>;

  constructor(
    @Inject(VIVA_PLUGIN_OPTIONS)
    private readonly options: VivaPaymentPluginOptions,
    private readonly connection: TransactionalConnection,
    private readonly jobQueueService: JobQueueService,
  ) {}

  async onModuleInit(): Promise<void> {
    // Create the queue once at startup. V7 will register the process handler;
    // here we provide a no-op so the queue can be used for add() calls.
    this.webhookQueue = await this.jobQueueService.createQueue<ProcessVivaWebhookJobData>({
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
  @Get()
  handleVerification(@Res() res: ServerResponse): void {
    const key = this.options.webhookVerificationKey;

    if (!key) {
      Logger.warn(
        'webhookVerificationKey is not configured — returning 503. Set VIVA_WEBHOOK_VERIFICATION_KEY.',
        VIVA_LOG_CONTEXT,
      );
      res.writeHead(503, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'webhook key not configured' }));
      return;
    }

    // Capital `Key` per the documented verification response
    // (webhooks-for-payments.txt:362) and the core `buildChallengeResponse`
    // helper. Viva's own sample responds lowercase so its verifier is likely
    // case-insensitive, but we emit the documented shape.
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ Key: key }));
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
  @Post()
  async handleEvent(
    @Req() req: IncomingMessage & { body?: unknown },
    @Res() res: ServerResponse,
  ): Promise<void> {
    // ------------------------------------------------------------------
    // 1. IP allowlist (CSO Finding #2)
    // ------------------------------------------------------------------
    // trustedProxyDepth tells the helper how many trailing X-Forwarded-For
    // hops are set by operator-controlled proxies; the leftmost (attacker-
    // controllable) entries are ignored.
    const sourceIp = getSourceIp(req, this.options.trustedProxyDepth ?? 0);
    const allowlist = this.options.webhookIpAllowlist;

    if (!isIpAllowed(sourceIp, allowlist)) {
      Logger.warn(
        `Webhook POST rejected: source IP ${sourceIp} not in allowlist.`,
        VIVA_LOG_CONTEXT,
      );
      res.writeHead(403, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'forbidden' }));
      return;
    }

    // ------------------------------------------------------------------
    // 2. Parse envelope
    // ------------------------------------------------------------------
    const body = req.body as VivaWebhookEnvelope | undefined;

    if (!body || typeof body.MessageId !== 'string' || !body.MessageId) {
      Logger.warn('Webhook POST: missing or invalid MessageId.', VIVA_LOG_CONTEXT);
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'malformed envelope' }));
      return;
    }

    if (typeof body.EventTypeId !== 'number' || !body.EventTypeId) {
      Logger.warn(
        `Webhook POST: missing or invalid EventTypeId for MessageId=${body.MessageId}.`,
        VIVA_LOG_CONTEXT,
      );
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'malformed envelope' }));
      return;
    }

    const messageId = body.MessageId;
    const eventTypeId = body.EventTypeId;
    const eventData = (body.EventData ?? {}) as Record<string, unknown>;

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
        merchantId: (eventData['MerchantId'] as string | undefined) ?? null,
        transactionId: (eventData['TransactionId'] as string | undefined) ?? null,
        // Viva names the onboarding account id `ConnectedAccountId` in EVERY
        // payload (transaction + onboarding) — there is no `AccountId` key.
        // Reading the wrong name left accountId NULL, which made the 8194
        // handler short-circuit and never flip vivaPayoutsEnabled.
        accountId: (eventData['ConnectedAccountId'] as string | undefined) ?? null,
        correlationId: body.CorrelationId ?? null,
        // Internal processing counter — ALWAYS starts at 0. Do NOT seed from the
        // envelope's `RetryCount` (Viva's DELIVERY retry count): the A6
        // channel-resolution fallback reuses this column as its own attempt
        // index, so a redelivery with RetryCount>=4 would make A6 give up
        // immediately. Viva's delivery count remains queryable in `payload`.
        retryCount: 0,
        // Cast to any: TypeORM's _QueryDeepPartialEntity doesn't accept
        // plain objects for jsonb columns — the value is serialised correctly
        // at the driver level.
        payload: body as any,
      })
      .orIgnore()
      .execute();

    const rowsInserted = insertResult.identifiers.length;

    // ------------------------------------------------------------------
    // 4. Deduplicate — already processed replay
    // ------------------------------------------------------------------
    if (rowsInserted === 0) {
      Logger.debug(
        `Webhook POST: duplicate MessageId=${messageId} (replay) — skipping enqueue.`,
        VIVA_LOG_CONTEXT,
      );
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
      return;
    }

    // ------------------------------------------------------------------
    // 5. Enqueue BullMQ job (resilient — 200 even if enqueue fails)
    // ------------------------------------------------------------------
    try {
      await this.webhookQueue.add({ messageId });
    } catch (err) {
      // Row is persisted; V7's worker can pick it up via reprocess logic (A6).
      Logger.warn(
        `Webhook POST: job enqueue failed for MessageId=${messageId}. Row persisted; worker will retry. Error: ${String(err)}`,
        VIVA_LOG_CONTEXT,
      );
    }

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true }));
  }
}
