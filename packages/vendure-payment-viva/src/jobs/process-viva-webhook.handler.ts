/**
 * jobs/process-viva-webhook.handler.ts — BullMQ webhook worker job handler.
 *
 * Registered with Vendure's JobQueueService at bootstrap. Processes one
 * `viva_webhook_event` row per job execution.
 *
 * Process flow (see plan §"Webhook Design — Process flow"):
 *  1. Load row by messageId. Already-processed or missing → no-op.
 *  2. Resolve channel by EventData.MerchantId (60s LRU cache).
 *     If not found → A6 NULL-merchant fallback: mark row, bump retry_count.
 *     A 60s sweep (`sweepChannelNotFound`) re-enqueues due rows on the
 *     backoff schedule — Vendure's JobQueue.add has no delay option.
 *  3. Acquire per-merchant in-process semaphore (5 permits).
 *  4. Switch on eventTypeId:
 *     1796 → Retrieve-Transaction → validate → settle
 *     1798 → mark Declined, leave order in ArrangingPayment
 *     1797 → settle the matching Pending Refund (#5), else record a refund made outside Vendure (#31)
 *     4865 → optional cancel detection
 *     8193 → log only
 *     8194 → write vivaMerchantId THEN vivaPayoutsEnabled
 *  5. Release semaphore.
 *
 * @see docs/plans/vendure-plugin-v0.md §"Build Plan — V7"
 * @see docs/plans/vendure-plugin-v0.md §"Webhook Design — Process flow"
 * @see docs/VENDURE-CONTRACT.MD §4, §5, §10
 */

import { Injectable, Inject } from '@nestjs/common';
import type { OnApplicationBootstrap, OnApplicationShutdown } from '@nestjs/common';
import { Between, IsNull } from 'typeorm';
import {
  JobQueueService,
  JobQueue,
  Logger,
  TransactionalConnection,
  RequestContextService,
  OrderService,
  ChannelService,
  PaymentService,
  Refund,
  EventBus,
  ProcessContext,
} from '@vendure/core';
import type { Job, ID } from '@vendure/core';
import { IsvHttpClient, IsvAccounts } from '@sakeetech/viva-payments-core/isv';
import { Payments } from '@sakeetech/viva-payments-core/payments';
import { redactIds } from '@sakeetech/viva-payments-core/observability';
import type { VivaPaymentPluginOptions } from '../types.js';
import { VivaOAuth2StrategyProvider } from '../providers/viva-oauth2-strategy.provider.js';
import type { VivaOAuth2Strategy } from '../providers/viva-oauth2-strategy.provider.js';
import { StateMachineService } from '../services/state-machine.service.js';
import { PerMerchantSemaphore } from '../services/per-merchant-semaphore.service.js';
import { ConnectedAccountsService } from '../services/connected-accounts.service.js';
import { VivaWebhookEvent } from '../entities/viva-webhook-event.entity.js';
import { VivaTransaction } from '../entities/viva-transaction.entity.js';
import { VivaPluginError, describeError } from '../util/error-envelope.js';
import { checkVivaRefund, pendingRefundKey, recordExternalRefund } from '../payment-method-handler.js';
import { VivaExternalRefundEvent } from '../events.js';
import {
  VIVA_PLUGIN_OPTIONS,
  VIVA_OAUTH2_STRATEGY_TOKEN,
  VIVA_LOG_CONTEXT,
  VIVA_WEBHOOK_QUEUE,
  VIVA_PROCESS_EVENT_JOB,
} from '../constants.js';
import type { ProcessVivaWebhookJobData } from './queue-names.js';

// ---------------------------------------------------------------------------
// Channel-resolution LRU cache (process-local, 60s TTL)
// ---------------------------------------------------------------------------

interface CacheEntry {
  channelId: number | string;
  expiresAt: number;
}

const CHANNEL_CACHE_TTL_MS = 60_000;
const merchantChannelCache = new Map<string, CacheEntry>();

function getCachedChannelId(merchantId: string): number | string | undefined {
  const entry = merchantChannelCache.get(merchantId);
  if (!entry) return undefined;
  if (Date.now() > entry.expiresAt) {
    merchantChannelCache.delete(merchantId);
    return undefined;
  }
  return entry.channelId;
}

function setCachedChannelId(merchantId: string, channelId: number | string): void {
  merchantChannelCache.set(merchantId, { channelId, expiresAt: Date.now() + CHANNEL_CACHE_TTL_MS });
}

// ---------------------------------------------------------------------------
// Backoff schedule for A6 NULL-merchant fallback (4 attempts max)
// ---------------------------------------------------------------------------

const A6_BACKOFF_DELAYS_MS: number[] = [
  60_000,          //  1 min
  5 * 60_000,      //  5 min
  30 * 60_000,     // 30 min
  2 * 60 * 60_000, //  2 hr
];
export const A6_CHANNEL_NOT_FOUND = 'channel-not-found';
export const A6_CHANNEL_NOT_FOUND_EXHAUSTED = 'channel-not-found-exhausted';
const A6_SWEEP_INTERVAL_MS = 60_000;

/**
 * A6 retry `n` (1-based = row.retryCount) is due at
 * `receivedAt + sum(A6_BACKOFF_DELAYS_MS[0..n-1])`. Derived from columns that
 * already exist — no `next_attempt_at` column, no in-process timer to lose on
 * restart.
 */
export function a6RetryDueAt(receivedAt: Date, retryCount: number): Date {
  let delay = 0;
  for (let i = 0; i < retryCount && i < A6_BACKOFF_DELAYS_MS.length; i++) delay += A6_BACKOFF_DELAYS_MS[i]!;
  return new Date(receivedAt.getTime() + delay);
}

// ---------------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------------

@Injectable()
export class ProcessVivaWebhookHandler implements OnApplicationBootstrap, OnApplicationShutdown {
  private queue!: JobQueue<ProcessVivaWebhookJobData>;
  private _a6Timer: ReturnType<typeof setInterval> | undefined;

  constructor(
    private readonly jobQueueService: JobQueueService,
    private readonly connection: TransactionalConnection,
    private readonly stateMachine: StateMachineService,
    private readonly semaphore: PerMerchantSemaphore,
    private readonly connectedAccounts: ConnectedAccountsService,
    private readonly orderService: OrderService,
    private readonly paymentService: PaymentService,
    private readonly channelService: ChannelService,
    private readonly requestContextService: RequestContextService,
    private readonly eventBus: EventBus,
    private readonly processContext: ProcessContext,
    @Inject(VIVA_PLUGIN_OPTIONS) private readonly options: VivaPaymentPluginOptions,
    @Inject(VIVA_OAUTH2_STRATEGY_TOKEN) private readonly oauth2: VivaOAuth2Strategy,
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    this.queue = await this.jobQueueService.createQueue<ProcessVivaWebhookJobData>({
      name: VIVA_WEBHOOK_QUEUE,
      process: (job) => this._processJob(job),
    });
    // Plugins bootstrap in BOTH the server and the worker process. Only the
    // worker sweeps, or every due row would be enqueued twice per tick and a
    // duplicate run would burn a retry.
    if (!this.processContext.isWorker) return;
    // Same setInterval-in-bootstrap pattern as RetentionCleanupHandler: no
    // scheduler dep, no consumer config. State lives in the DB row, so a
    // restart loses nothing. ponytail: no cross-instance lock — two worker instances
    // may both enqueue the same row in one tick; the job is idempotent and a
    // duplicate at worst burns one attempt. Move to Vendure ScheduledTask if
    // that ever matters.
    this._a6Timer = setInterval(() => {
      this.sweepChannelNotFound().catch((err) =>
        Logger.error(`[webhook] A6 sweep failed: ${describeError(err)}`, VIVA_LOG_CONTEXT),
      );
    }, A6_SWEEP_INTERVAL_MS);
    this._a6Timer.unref?.();
  }

  onApplicationShutdown(): void {
    if (this._a6Timer) clearInterval(this._a6Timer);
  }

  /**
   * Re-enqueue A6 "channel not found" rows whose backoff has elapsed.
   * Returns the number of jobs enqueued. Exposed for tests.
   */
  async sweepChannelNotFound(now: Date = new Date()): Promise<number> {
    const eventRepo = this.connection.rawConnection.getRepository(VivaWebhookEvent);
    const rows = await eventRepo.find({
      where: { processedAt: IsNull(), error: A6_CHANNEL_NOT_FOUND, retryCount: Between(1, A6_BACKOFF_DELAYS_MS.length) },
      select: { messageId: true, receivedAt: true, retryCount: true },
    });
    let enqueued = 0;
    for (const row of rows) {
      if (a6RetryDueAt(row.receivedAt, row.retryCount) > now) continue;
      await this.queue.add({ messageId: row.messageId }, { retries: 0 });
      enqueued++;
    }
    if (enqueued > 0) Logger.info(`[webhook] A6 sweep re-enqueued ${enqueued} event(s).`, VIVA_LOG_CONTEXT);
    return enqueued;
  }

  // ---------------------------------------------------------------------------
  // Core job logic
  // ---------------------------------------------------------------------------

  private async _processJob(job: Job<ProcessVivaWebhookJobData>): Promise<void> {
    const { messageId } = job.data;

    // -------------------------------------------------------------------------
    // Step 1: load event row
    // -------------------------------------------------------------------------
    const eventRepo = this.connection.rawConnection.getRepository(VivaWebhookEvent);
    const event = await eventRepo.findOne({ where: { messageId } });

    if (!event) {
      Logger.info(`[webhook] Row not found — possibly deleted or never inserted. Skipping.`, VIVA_LOG_CONTEXT);
      return;
    }

    if (event.processedAt !== null) {
      Logger.info(`[webhook] Already processed at ${event.processedAt.toISOString()}. Idempotent no-op.`, VIVA_LOG_CONTEXT);
      return;
    }

    // -------------------------------------------------------------------------
    // Step 2: resolve channel.
    //
    //   ISV mode      → look up by `EventData.MerchantId` (LRU + linear scan).
    //                   A NULL merchantId triggers A6 backoff fallback.
    //   Merchant mode → there is no per-tenant merchantId in single-merchant
    //                   deployments. Resolve to the default channel; only one
    //                   merchant is configured plugin-wide, so all webhook
    //                   events belong to the default channel.
    //                   @see docs/plans/multi-mode-v0.md §9 (webhook channel resolution)
    // -------------------------------------------------------------------------
    const merchantId = event.merchantId;

    // Build a system-level ctx for channel operations (no channel known yet)
    const systemCtx = await this.requestContextService.create({ apiType: 'admin' });

    let channelId: number | string | undefined;

    if (this.options.mode !== 'isv') {
      // Merchant mode: use the default channel. Single-merchant deployments
      // have no per-tenant mapping to perform — the operator may run multiple
      // Vendure channels for catalog/locale split, but Viva traffic belongs
      // to the default channel registered when the plugin was initialized.
      const defaultChannel = await this.channelService.getDefaultChannel(systemCtx);
      channelId = defaultChannel.id as number | string;
    } else if (merchantId) {
      // ISV mode: check LRU cache first.
      channelId = getCachedChannelId(merchantId);

      if (!channelId) {
        // Linear scan over channels (typically ≤ N=10 channels per deployment)
        const allChannels = await this.channelService.findAll(systemCtx);
        for (const ch of allChannels.items) {
          const cf = (ch as any).customFields as Record<string, unknown> | undefined;
          if (cf && cf['vivaMerchantId'] === merchantId) {
            channelId = ch.id as number | string;
            setCachedChannelId(merchantId, channelId);
            break;
          }
        }
      }
    }

    if (!channelId) {
      // A6 NULL-merchant fallback: mark the row and bump retry_count. The
      // sweep re-enqueues it once the backoff has elapsed; the exhausted
      // marker keeps the sweep from picking the row up forever.
      const attemptIndex = event.retryCount;
      if (attemptIndex < A6_BACKOFF_DELAYS_MS.length) {
        await eventRepo.update({ messageId }, { merchantId: null, error: A6_CHANNEL_NOT_FOUND });
        await eventRepo.increment({ messageId }, 'retryCount', 1);
        Logger.warn(
          `[webhook] Channel not found for the event's merchant. Reprocess attempt ${attemptIndex + 1} due in ${A6_BACKOFF_DELAYS_MS[attemptIndex]!}ms.`,
          VIVA_LOG_CONTEXT,
        );
      } else {
        await eventRepo.update({ messageId }, { merchantId: null, error: A6_CHANNEL_NOT_FOUND_EXHAUSTED });
        Logger.error(
          `[webhook] Channel not found after ${attemptIndex} attempts for the event's merchant. Row left stuck — check metrics.`,
          VIVA_LOG_CONTEXT,
        );
      }
      return;
    }

    // -------------------------------------------------------------------------
    // Step 3: acquire per-merchant semaphore
    // -------------------------------------------------------------------------
    const release = await this.semaphore.acquire(merchantId ?? `channel:${String(channelId)}`);

    try {
      // Build a channel-scoped ctx for order/payment operations
      const ctx = await this.requestContextService.create({ apiType: 'admin', channelOrToken: await this._loadChannel(channelId) });

      // -----------------------------------------------------------------------
      // Step 4: switch on eventTypeId
      // -----------------------------------------------------------------------
      switch (event.eventTypeId) {

        case 1796:
          await this._handle1796(ctx, event, eventRepo);
          break;

        case 1798:
          await this._handle1798(ctx, event, eventRepo);
          break;

        case 1797:
          await this._handle1797(ctx, event, eventRepo);
          break;

        case 4865:
          await this._handle4865(ctx, event, eventRepo);
          break;

        case 8193:
          // Onboarding lifecycle event — only meaningful in ISV mode (there is
          // no onboarding flow in merchant mode). Mark processed in both modes
          // to prevent infinite reprocessing.
          Logger.info(
            `[webhook] 8193 Account Connected — analytics, no state change` +
              `${this.options.mode === 'isv' ? '' : ' (merchant mode: no-op)'}.`,
            VIVA_LOG_CONTEXT,
          );
          await this._markProcessed(eventRepo, messageId);
          break;

        case 8194:
          if (this.options.mode === 'isv') {
            await this._handle8194(systemCtx, event, eventRepo);
          } else {
            // Merchant mode: no onboarding flip — the merchant configured the
            // plugin with their own legacyMerchantId / legacyApiKey directly,
            // so the verification status is moot for plugin behaviour.
            Logger.info(
              `[webhook] 8194 Account Verification — merchant mode: no-op.`,
              VIVA_LOG_CONTEXT,
            );
            await this._markProcessed(eventRepo, messageId);
          }
          break;

        default:
          Logger.info(
            `[webhook] Unknown eventTypeId=${event.eventTypeId} — marking processed to prevent infinite reprocessing.`,
            VIVA_LOG_CONTEXT,
          );
          await this._markProcessed(eventRepo, messageId);
          break;
      }
    } finally {
      await release();
    }
  }

  // ---------------------------------------------------------------------------
  // Event handlers
  // ---------------------------------------------------------------------------

  /**
   * 1796 — Transaction Payment Created (settle path).
   *
   * a. Retrieve transaction from Viva.
   * b. Validate orderCode, statusId='F', amount.
   * c. Load order + payment, check current state.
   * d. Settle (or re-walk if AddingItems).
   * e. Update viva_transaction row.
   * f. Mark event processed.
   */
  private async _handle1796(
    ctx: any,
    event: VivaWebhookEvent,
    eventRepo: ReturnType<typeof this.connection.rawConnection.getRepository>,
  ): Promise<void> {
    const { messageId } = event;
    const payload = event.payload as Record<string, unknown>;
    const eventData = (payload['EventData'] ?? payload) as Record<string, unknown>;
    const transactionId = (event.transactionId ?? (eventData['TransactionId'] as string | undefined));
    const merchantId = event.merchantId;

    if (!transactionId) {
      await eventRepo.update({ messageId }, { error: 'missing-transaction-id' });
      Logger.error(`[webhook] 1796: no transactionId in payload.`, VIVA_LOG_CONTEXT);
      return;
    }

    // a. Retrieve transaction from Viva.
    // - ISV mode: pass merchantId from the webhook payload → /isv/transactions/{id}?merchantId=…
    // - Merchant mode: omit merchantId → /transactions/{id} (Payments drops it anyway).
    const isvPayments = this._getIsvPayments();
    let vivaTransaction: Awaited<ReturnType<Payments['retrieveTransaction']>>;
    try {
      const retrieveOpts: { merchantId?: any } =
        this.options.mode === 'isv' && merchantId ? { merchantId } : {};
      vivaTransaction = await isvPayments.retrieveTransaction(transactionId as any, retrieveOpts);
    } catch (err) {
      await eventRepo.update({ messageId }, { error: `retrieve-failed: ${describeError(err)}` });
      throw err; // Let BullMQ retry
    }

    // b. Validate
    // CSO-Finding-1 (defensive): we look up the local row by vivaTransaction.orderCode
    // (the value returned by Viva's authenticated retrieveTransaction call) — NOT by
    // the OrderCode in the webhook envelope, which is attacker-controlled. Do not
    // regress this to use the envelope OrderCode without adding an explicit
    // envelope-vs-live cross-check first. See docs/TODO-CSO.md "Finding 1" and the
    // canonical Viva WooCommerce plugin (class-wc-vivacom-smart-endpoints.php:132).
    const vivaOrderCodeStr = vivaTransaction.orderCode?.toString();
    const txnRepo = this.connection.rawConnection.getRepository(VivaTransaction);

    // Find the viva_transaction row by order code
    const vivaRow = await txnRepo.findOne({ where: { vivaOrderCode: vivaOrderCodeStr } as any });

    if (!vivaRow) {
      const errMsg = 'viva_transaction row not found for order code';
      await eventRepo.update({ messageId }, { error: errMsg });
      Logger.error('[webhook] 1796: viva_transaction row not found for the Viva order code.', VIVA_LOG_CONTEXT);
      return;
    }

    if (vivaTransaction.statusId !== 'F') {
      const errMsg = `statusId is '${vivaTransaction.statusId}', expected 'F'`;
      await eventRepo.update({ messageId }, { error: errMsg });
      Logger.warn(`[webhook] 1796: ${errMsg} — not settling.`, VIVA_LOG_CONTEXT);
      return;
    }

    const expectedAmount = BigInt(vivaRow.amountMinor);
    const actualAmount = vivaTransaction.amount;
    if (expectedAmount !== actualAmount) {
      await eventRepo.update({ messageId }, { error: `VIVA_AMOUNT_MISMATCH: expected=${expectedAmount} actual=${actualAmount}` });
      throw VivaPluginError.amountMismatch(expectedAmount, Number(actualAmount));
    }

    // c. Load payment then order via paymentId on the viva_transaction row
    const paymentId = vivaRow.paymentId;
    let order: Awaited<ReturnType<OrderService['findOne']>> | null = null;
    try {
      const payment = await this.paymentService.findOneOrThrow(ctx, paymentId as any, ['order']);
      if (payment.order) {
        order = await this.orderService.findOne(ctx, payment.order.id);
      }
    } catch {
      // Payment not found
    }

    if (!order) {
      const errMsg = 'order not found for payment';
      await eventRepo.update({ messageId }, { error: errMsg });
      Logger.error('[webhook] 1796: order not found for the payment on the viva_transaction row.', VIVA_LOG_CONTEXT);
      return;
    }

    // d. Settle based on current order state
    try {
      if (order.state === 'PaymentSettled') {
        // Idempotent no-op
        Logger.info(`[webhook] 1796: order already PaymentSettled — idempotent no-op.`, VIVA_LOG_CONTEXT);
      } else if (order.state === 'AddingItems') {
        // Stale-order re-walk
        await this.stateMachine.recoverStaleOrderAndSettle(ctx, order.id, paymentId);
      } else if (order.state === 'ArrangingPayment' || order.state === 'PaymentAuthorized') {
        // Normal settle path
        await this.stateMachine.transitionPaymentToSettled(ctx, order.id, paymentId);
      } else {
        Logger.warn(
          `[webhook] 1796: unexpected order state '${order.state}' — attempting settlePayment anyway.`,
          VIVA_LOG_CONTEXT,
        );
        await this.stateMachine.transitionPaymentToSettled(ctx, order.id, paymentId);
      }
    } catch (err) {
      // Fail-loud per Q4: set error, leave processed_at NULL. Keep the
      // state-machine reason (errorCode) but redact ids — host rule: no
      // identifiers in stored errors (OPEN O5).
      const errMsg = `transition-failed: ${redactIds(err instanceof Error ? err.message : String(err))}`;
      await eventRepo.update({ messageId }, { error: errMsg });
      Logger.error(`[webhook] 1796: transition failed — ${describeError(err)}`, VIVA_LOG_CONTEXT);
      throw err;
    }

    // e. Update viva_transaction row.
    //
    // Only mark THIS row 'captured' if THIS payment actually reached 'Settled'.
    // The row is keyed to a specific paymentId, but the settle branches above key
    // on order STATE — so the `PaymentSettled` idempotent no-op (line above) fires
    // when the order was already settled by a *different* payment, leaving this
    // payment in `Created`. Blindly stamping 'captured' there produced the #26
    // desync: a `Created` Vendure Payment with a `captured` row, which cancelPayment
    // (Step 3) then refuses to void — permanently bricking retry on
    // isvAmountTooHigh(99, 0). Re-read the payment after the transition and gate on
    // its real state so a captured row always implies a settled payment.
    let settledNow = false;
    try {
      const reloaded = await this.paymentService.findOneOrThrow(ctx, paymentId as any);
      settledNow = reloaded.state === 'Settled';
    } catch {
      // Payment vanished — treat as not-settled; never stamp 'captured' blind.
    }

    if (settledNow) {
      await txnRepo.update(
        { id: vivaRow.id },
        { status: 'captured', vivaTransactionId: transactionId },
      );
    } else {
      // Record the transaction id for traceability, but do NOT mark 'captured' —
      // this payment did not settle (order settled via a sibling payment). Leaving
      // the row non-terminal keeps the payment cancellable so the order can recover.
      await txnRepo.update({ id: vivaRow.id }, { vivaTransactionId: transactionId });
      Logger.warn(
        `[webhook] 1796: order is PaymentSettled but this payment ` +
          `did not settle — NOT marking row 'captured' (would brick cancel/retry, #26).`,
        VIVA_LOG_CONTEXT,
      );
    }

    // f. Mark processed
    await this._markProcessed(eventRepo, messageId);
    Logger.info(`[webhook] 1796: settled successfully.`, VIVA_LOG_CONTEXT);
  }

  /**
   * 1798 — Transaction Failed (declined-non-terminal).
   *
   * Mark payment Declined. Leave order in ArrangingPayment (per contract §4).
   * Do NOT auto-rollback to AddingItems — customer retry on same orderCode may succeed.
   *
   * SECURITY (CSO-Finding-1, same class as 1796): the order is resolved by the
   * orderCode returned from an AUTHENTICATED retrieveTransaction call keyed on
   * the envelope TransactionId — NOT by the envelope OrderCode, which is
   * attacker-controlled. Trusting the envelope OrderCode here would let anyone
   * past the IP allowlist force-decline an arbitrary order.
   */
  private async _handle1798(
    ctx: any,
    event: VivaWebhookEvent,
    eventRepo: ReturnType<typeof this.connection.rawConnection.getRepository>,
  ): Promise<void> {
    const { messageId } = event;
    const txnRepo = this.connection.rawConnection.getRepository(VivaTransaction);

    const payload = event.payload as Record<string, unknown>;
    const eventData = (payload['EventData'] ?? payload) as Record<string, unknown>;
    const transactionId = event.transactionId ?? (eventData['TransactionId'] as string | undefined);

    if (!transactionId) {
      // No transaction to authenticate against — cannot safely resolve the order.
      await eventRepo.update({ messageId }, { error: 'missing-transaction-id' });
      Logger.error(`[webhook] 1798: no transactionId in payload — cannot verify; not acting.`, VIVA_LOG_CONTEXT);
      return;
    }

    // Authenticated re-fetch → trustworthy orderCode (never the envelope value).
    let orderCodeStr: string | undefined;
    try {
      const tx = await this._retrieveAuthoritative(transactionId, event.merchantId);
      orderCodeStr = tx.orderCode?.toString();
    } catch (err) {
      await eventRepo.update({ messageId }, { error: `retrieve-failed: ${describeError(err)}` });
      throw err; // Let BullMQ retry
    }

    if (orderCodeStr) {
      const vivaRow = await txnRepo.findOne({ where: { vivaOrderCode: orderCodeStr } as any });
      if (vivaRow) {
        await txnRepo.update({ id: vivaRow.id }, { status: 'failed' });
        try {
          await this.stateMachine.transitionPaymentToDeclined(ctx, vivaRow.paymentId);
        } catch (err) {
          Logger.warn(`[webhook] 1798: could not transition payment to Declined: ${describeError(err)}`, VIVA_LOG_CONTEXT);
          // Non-fatal: the row status is already marked failed
        }
      }
    }

    await this._markProcessed(eventRepo, messageId);
    Logger.info(`[webhook] 1798: payment marked Declined (order stays ArrangingPayment).`, VIVA_LOG_CONTEXT);
  }

  /**
   * 1797 — Transaction Reversal Created (a refund) → settle our Pending Refund (#5).
   *
   * The envelope is attacker-controlled, so `ParentId` + `MerchantTrns` are only
   * a lookup hint: they find the payment's Pending Refund tagged with that key,
   * and `checkVivaRefund` settles it from Viva's AUTHENTICATED refund listing.
   * Not listed yet → throw so BullMQ retries (never Failed from a webhook).
   * No matching Pending Refund (dashboard refund, MerchantTrns null/unknown,
   * or already settled) → `_recordExternalRefund` (#31). No row with that
   * `ParentId` in any channel (1796 not processed yet) → retry.
   */
  private async _handle1797(
    ctx: any,
    event: VivaWebhookEvent,
    eventRepo: ReturnType<typeof this.connection.rawConnection.getRepository>,
  ): Promise<void> {
    const { messageId } = event;
    const payload = event.payload as Record<string, unknown>;
    const eventData = (payload['EventData'] ?? payload) as Record<string, unknown>;
    const parentId = eventData['ParentId'] as string | null | undefined;
    const merchantTrns = eventData['MerchantTrns'] as string | null | undefined;
    const transactionId = event.transactionId ?? (eventData['TransactionId'] as string | undefined);

    const vivaRow = parentId
      ? await this.connection.rawConnection.getRepository(VivaTransaction).findOne({ where: { vivaTransactionId: parentId, channelId: ctx.channelId } })
      : null;
    const pending = vivaRow && merchantTrns
      ? (await this.connection.getRepository(ctx, Refund).find({ where: { paymentId: vivaRow.paymentId as any, state: 'Pending' } }))
          .find((r) => pendingRefundKey(r) === merchantTrns)
      : undefined;
    if (!pending) {
      if (!vivaRow && parentId) {
        // #31: vivaTransactionId is written when the payment's 1796 is processed. No row in ANY
        // channel → that 1796 may be late: retry (bounded by the queue's attempts, so a forged
        // ParentId just exhausts them). A row in another channel → misrouted (#5): log only.
        await this._check1797(ctx, eventRepo, messageId, 'payment-not-recorded-yet', async () => {
          if (!(await this.connection.rawConnection.getRepository(VivaTransaction).existsBy({ vivaTransactionId: parentId }))) {
            throw new Error('[webhook] 1797: its payment is not recorded yet; retrying.');
          }
          return { outcome: 'misrouted' };
        });
        Logger.info(`[webhook] 1797 Refund Created — no payment of this channel to match; audit log only.`, VIVA_LOG_CONTEXT);
        return;
      }
      if (!vivaRow || !transactionId) {
        // Viva always sends a TransactionId, so a retry can't help: processed, but warned.
        if (vivaRow) Logger.warn(`[webhook] 1797 Refund Created without a TransactionId; outside refund not recorded.`, VIVA_LOG_CONTEXT);
        else Logger.info(`[webhook] 1797 Refund Created — no payment of this channel to match; audit log only.`, VIVA_LOG_CONTEXT);
        await this._markProcessed(eventRepo, messageId);
        return;
      }
      await this._recordExternalRefund(ctx, event, eventRepo, vivaRow.paymentId, transactionId);
      return;
    }

    const outcome = await this._check1797(ctx, eventRepo, messageId, 'refund-check-failed', (txCtx) => checkVivaRefund(txCtx, pending.id));
    Logger.info(`[webhook] 1797: Pending refund ${outcome === 'settled' ? 'settled' : 'already failed'}.`, VIVA_LOG_CONTEXT);
  }

  /**
   * 1797: run `check` in a transaction. A throw writes `{label}: describeError`
   * to the event's error column and rethrows; 'absent' writes
   * `refund-not-listed-yet` and throws (a webhook never fails a refund: the
   * listing may lag). Either way BullMQ retries. Else the event is processed.
   */
  private async _check1797<T extends { outcome: string }>(
    ctx: any,
    eventRepo: ReturnType<typeof this.connection.rawConnection.getRepository>,
    messageId: string,
    label: string,
    check: (txCtx: any) => Promise<T>,
  ): Promise<T['outcome']> {
    let result: T;
    try {
      result = await this.connection.withTransaction(ctx, check);
    } catch (err) {
      await eventRepo.update({ messageId }, { error: `${label}: ${describeError(err)}` });
      throw err; // Let BullMQ retry
    }
    if (result.outcome === 'absent') {
      await eventRepo.update({ messageId }, { error: 'refund-not-listed-yet' });
      throw new Error('[webhook] 1797: Viva does not list the refund yet; retrying.');
    }
    await this._markProcessed(eventRepo, messageId);
    return result.outcome;
  }

  /**
   * #31: 1797 matching no Pending refund (MerchantTrns null or unknown) → a
   * refund made outside Vendure, recorded on the payment's row from Viva's
   * authenticated listing (`recordExternalRefund`), then `VivaExternalRefundEvent`.
   * Not listed yet / listing fails → throw so BullMQ retries. Replay, or a
   * refund Vendure already has → no-op, no event.
   */
  private async _recordExternalRefund(
    ctx: any,
    event: VivaWebhookEvent,
    eventRepo: ReturnType<typeof this.connection.rawConnection.getRepository>,
    paymentId: ID,
    transactionId: string,
  ): Promise<void> {
    const outcome = await this._check1797(ctx, eventRepo, event.messageId, 'external-refund-check-failed', async (txCtx) => {
      const payment = await this.paymentService.findOneOrThrow(txCtx, paymentId, ['order']);
      const result = await recordExternalRefund(txCtx, payment, transactionId);
      // Published with the transaction's ctx: subscribers get it after COMMIT, never on rollback.
      if (result.outcome === 'recorded') {
        await this.eventBus.publish(new VivaExternalRefundEvent(txCtx, payment.order.id, payment.id, result.amount));
      }
      return result;
    });
    Logger.info(
      `[webhook] 1797: ${outcome === 'recorded' ? 'refund made outside Vendure recorded' : 'refund already recorded; no change'}.`,
      VIVA_LOG_CONTEXT,
    );
  }

  /**
   * 4865 — Order Updated (optional cancel detection).
   *
   * SECURITY (CSO-Finding-1): the destructive cancel path (cancel payment +
   * roll order back to AddingItems) must NOT fire on attacker-controllable
   * envelope values. We resolve BOTH the cancel-status decision and the order
   * lookup from an AUTHENTICATED retrieveTransaction keyed on the envelope
   * TransactionId. If the envelope carries no TransactionId we cannot verify
   * the order server-side (there is no GET order-by-code on the OAuth2 host),
   * so we log and take no destructive action rather than trust the envelope.
   */
  private async _handle4865(
    ctx: any,
    event: VivaWebhookEvent,
    eventRepo: ReturnType<typeof this.connection.rawConnection.getRepository>,
  ): Promise<void> {
    const { messageId } = event;
    const payload = event.payload as Record<string, unknown>;
    const eventData = (payload['EventData'] ?? payload) as Record<string, unknown>;
    const transactionId = event.transactionId ?? (eventData['TransactionId'] as string | undefined);

    if (!transactionId) {
      Logger.info(`[webhook] 4865 Order Updated — no transactionId to verify against; not acting on envelope alone.`, VIVA_LOG_CONTEXT);
      await this._markProcessed(eventRepo, messageId);
      return;
    }

    // Authenticated re-fetch → trustworthy statusId + orderCode.
    let statusId: string | undefined;
    let orderCodeStr: string | undefined;
    try {
      const tx = await this._retrieveAuthoritative(transactionId, event.merchantId);
      statusId = tx.statusId;
      orderCodeStr = tx.orderCode?.toString();
    } catch (err) {
      await eventRepo.update({ messageId }, { error: `retrieve-failed: ${describeError(err)}` });
      throw err; // Let BullMQ retry
    }

    // Cancelled/expired/errored — decided from the AUTHENTICATED status.
    // TODO(impl): confirm the exact 4865 cancel statusId set against a live probe.
    const isCancelStatus = statusId === 'X' || statusId === 'C' || statusId === 'E';

    if (isCancelStatus && orderCodeStr) {
      const txnRepo = this.connection.rawConnection.getRepository(VivaTransaction);
      const vivaRow = await txnRepo.findOne({ where: { vivaOrderCode: orderCodeStr } as any });

      if (vivaRow) {
        await txnRepo.update({ id: vivaRow.id }, { status: 'cancelled' });
        try {
          await this.stateMachine.transitionPaymentToCancelled(ctx, vivaRow.paymentId);
        } catch (err) {
          Logger.warn(`[webhook] 4865: could not cancel payment: ${describeError(err)}`, VIVA_LOG_CONTEXT);
        }
        // Transition order back to AddingItems
        try {
          const payment = await this.paymentService.findOneOrThrow(ctx, vivaRow.paymentId as any, ['order']);
          if (payment.order) {
            await this.orderService.transitionToState(ctx, payment.order.id, 'AddingItems' as any);
          }
        } catch (err) {
          Logger.warn(`[webhook] 4865: could not transition order to AddingItems: ${describeError(err)}`, VIVA_LOG_CONTEXT);
        }
      }
    } else {
      Logger.info(`[webhook] 4865 Order Updated — status=${statusId ?? 'unknown'}, no cancel action needed.`, VIVA_LOG_CONTEXT);
    }

    await this._markProcessed(eventRepo, messageId);
  }

  /**
   * Authenticated transaction fetch shared by the settle/decline/cancel paths.
   * The returned `orderCode`/`statusId` are trustworthy (Viva-signed via OAuth2),
   * unlike the webhook envelope. ISV mode scopes by the row's merchantId.
   */
  private async _retrieveAuthoritative(
    transactionId: string,
    merchantId: string | null,
  ): Promise<Awaited<ReturnType<Payments['retrieveTransaction']>>> {
    const isvPayments = this._getIsvPayments();
    const retrieveOpts: { merchantId?: any } =
      this.options.mode === 'isv' && merchantId ? { merchantId } : {};
    return isvPayments.retrieveTransaction(transactionId as any, retrieveOpts);
  }

  /**
   * 8194 — Account Verification Status Changed (THE gating signal).
   *
   * a. Retrieve connected account from Viva to get merchantId.
   * b. Find channel by vivaAccountId.
   * c. WRITE ORDER (mandatory per contract §10):
   *    i.  Write vivaMerchantId FIRST.
   *    ii. Write vivaPayoutsEnabled=true LAST.
   */
  private async _handle8194(
    systemCtx: any,
    event: VivaWebhookEvent,
    eventRepo: ReturnType<typeof this.connection.rawConnection.getRepository>,
  ): Promise<void> {
    const { messageId } = event;
    const accountId = event.accountId;

    if (!accountId) {
      await eventRepo.update({ messageId }, { error: 'missing-account-id' });
      Logger.error(`[webhook] 8194: no accountId in event row.`, VIVA_LOG_CONTEXT);
      return;
    }

    // a. Retrieve connected account from Viva
    const isvAccounts = this._getIsvAccounts();
    let merchantId: string | undefined;
    try {
      const accountInfo = await isvAccounts.retrieveConnectedAccount(accountId as any);
      // Probe-verified 2026-05-11: `merchantId` is the exact field name (null until verified).
      merchantId = accountInfo.merchantId ?? undefined;
    } catch (err) {
      const errMsg = `retrieve-account-failed: ${describeError(err)}`;
      await eventRepo.update({ messageId }, { error: errMsg });
      throw err; // Let BullMQ retry
    }

    if (!merchantId) {
      await eventRepo.update({ messageId }, { error: 'merchant-id-not-returned' });
      Logger.warn(`[webhook] 8194: merchantId not in account response — verification may be incomplete.`, VIVA_LOG_CONTEXT);
      return;
    }

    // b. Find channel by vivaAccountId
    const channel = await this.connectedAccounts.findChannelByAccountId(accountId);
    if (!channel) {
      await eventRepo.update({ messageId }, { error: 'channel not found for account' });
      Logger.error(`[webhook] 8194: no channel found for the connected account.`, VIVA_LOG_CONTEXT);
      return;
    }

    // c. Write order matters: merchantId FIRST, payoutsEnabled LAST
    // Build a system ctx with write permissions (superadmin = all channels)
    const writeCtx = await this.requestContextService.create({ apiType: 'admin' });

    // i. Write vivaMerchantId FIRST
    await this.connectedAccounts.writeMerchantId(writeCtx, channel, merchantId);

    // ii. Write vivaPayoutsEnabled LAST
    await this.connectedAccounts.flipPayoutsEnabled(writeCtx, channel, true);

    await this._markProcessed(eventRepo, messageId);
    Logger.info(
      `[webhook] 8194: channel now has a merchant id and payoutsEnabled=true.`,
      VIVA_LOG_CONTEXT,
    );
  }

  // ---------------------------------------------------------------------------
  // Helpers
  // ---------------------------------------------------------------------------

  private async _markProcessed(
    eventRepo: ReturnType<typeof this.connection.rawConnection.getRepository>,
    messageId: string,
  ): Promise<void> {
    await eventRepo.update({ messageId }, { processedAt: new Date(), error: null });
  }

  private async _loadChannel(channelId: number | string): Promise<any> {
    // Build a system-level ctx to load the channel object
    const sysCtx = await this.requestContextService.create({ apiType: 'admin' });
    return this.channelService.findOne(sysCtx, channelId as any);
  }

  private _getIsvPayments(): Payments {
    const client = new IsvHttpClient({
      environment: this.options.environment,
      authStrategy: this.oauth2,
    });
    return new Payments({ mode: this.options.mode, client });
  }

  private _getIsvAccounts(): IsvAccounts {
    const client = new IsvHttpClient({
      environment: this.options.environment,
      authStrategy: this.oauth2,
    });
    return new IsvAccounts(client);
  }
}
