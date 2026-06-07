/**
 * jobs/process-viva-webhook.handler.ts — BullMQ webhook worker job handler.
 *
 * Registered with Vendure's JobQueueService at bootstrap. Processes one
 * `viva_webhook_event` row per job execution.
 *
 * Process flow (see plan §"Webhook Design — Process flow"):
 *  1. Load row by messageId. Already-processed or missing → no-op.
 *  2. Resolve channel by EventData.MerchantId (60s LRU cache).
 *     If not found → A6 NULL-merchant fallback: schedule reprocess with backoff.
 *  3. Acquire per-merchant in-process semaphore (5 permits).
 *  4. Switch on eventTypeId:
 *     1796 → Retrieve-Transaction → validate → settle
 *     1798 → mark Declined, leave order in ArrangingPayment
 *     1797 → audit log only
 *     4865 → optional cancel detection
 *     8193 → log only
 *     8194 → write vivaMerchantId THEN vivaPayoutsEnabled
 *  5. Release semaphore.
 *
 * @see docs/plans/vendure-plugin-v0.md §"Build Plan — V7"
 * @see docs/plans/vendure-plugin-v0.md §"Webhook Design — Process flow"
 * @see docs/VENDURE-CONTRACT.MD §4, §5, §10
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
import { Injectable, Inject } from '@nestjs/common';
import { JobQueueService, JobQueue, Logger, TransactionalConnection, RequestContextService, OrderService, ChannelService, PaymentService, } from '@vendure/core';
import { IsvHttpClient, IsvAccounts } from '@sakeetech/viva-payments-core/isv';
import { Payments } from '@sakeetech/viva-payments-core/payments';
import { VivaOAuth2StrategyProvider } from '../providers/viva-oauth2-strategy.provider.js';
import { StateMachineService } from '../services/state-machine.service.js';
import { PerMerchantSemaphore } from '../services/per-merchant-semaphore.service.js';
import { ConnectedAccountsService } from '../services/connected-accounts.service.js';
import { VivaWebhookEvent } from '../entities/viva-webhook-event.entity.js';
import { VivaTransaction } from '../entities/viva-transaction.entity.js';
import { VivaPluginError } from '../util/error-envelope.js';
import { VIVA_PLUGIN_OPTIONS, VIVA_OAUTH2_STRATEGY_TOKEN, VIVA_LOG_CONTEXT, VIVA_WEBHOOK_QUEUE, VIVA_PROCESS_EVENT_JOB, } from '../constants.js';
const CHANNEL_CACHE_TTL_MS = 60_000;
const merchantChannelCache = new Map();
function getCachedChannelId(merchantId) {
    const entry = merchantChannelCache.get(merchantId);
    if (!entry)
        return undefined;
    if (Date.now() > entry.expiresAt) {
        merchantChannelCache.delete(merchantId);
        return undefined;
    }
    return entry.channelId;
}
function setCachedChannelId(merchantId, channelId) {
    merchantChannelCache.set(merchantId, { channelId, expiresAt: Date.now() + CHANNEL_CACHE_TTL_MS });
}
// ---------------------------------------------------------------------------
// Backoff schedule for A6 NULL-merchant fallback (4 attempts max)
// ---------------------------------------------------------------------------
const A6_BACKOFF_DELAYS_MS = [
    60_000, //  1 min
    5 * 60_000, //  5 min
    30 * 60_000, // 30 min
    2 * 60 * 60_000, //  2 hr
];
// ---------------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------------
let ProcessVivaWebhookHandler = class ProcessVivaWebhookHandler {
    jobQueueService;
    connection;
    stateMachine;
    semaphore;
    connectedAccounts;
    orderService;
    paymentService;
    channelService;
    requestContextService;
    options;
    oauth2;
    queue;
    constructor(jobQueueService, connection, stateMachine, semaphore, connectedAccounts, orderService, paymentService, channelService, requestContextService, options, oauth2) {
        this.jobQueueService = jobQueueService;
        this.connection = connection;
        this.stateMachine = stateMachine;
        this.semaphore = semaphore;
        this.connectedAccounts = connectedAccounts;
        this.orderService = orderService;
        this.paymentService = paymentService;
        this.channelService = channelService;
        this.requestContextService = requestContextService;
        this.options = options;
        this.oauth2 = oauth2;
    }
    async onApplicationBootstrap() {
        this.queue = await this.jobQueueService.createQueue({
            name: VIVA_WEBHOOK_QUEUE,
            process: (job) => this._processJob(job),
        });
    }
    /**
     * Enqueue a new webhook processing job.
     * Called by the webhook controller (V6) after INSERT-OR-NOTHING succeeds.
     */
    async enqueue(data, delayMs = 0) {
        await this.queue.add(data, delayMs > 0 ? { retries: 0 } : undefined);
    }
    // ---------------------------------------------------------------------------
    // Core job logic
    // ---------------------------------------------------------------------------
    async _processJob(job) {
        const { messageId } = job.data;
        // -------------------------------------------------------------------------
        // Step 1: load event row
        // -------------------------------------------------------------------------
        const eventRepo = this.connection.rawConnection.getRepository(VivaWebhookEvent);
        const event = await eventRepo.findOne({ where: { messageId } });
        if (!event) {
            Logger.info(`[webhook:${messageId}] Row not found — possibly deleted or never inserted. Skipping.`, VIVA_LOG_CONTEXT);
            return;
        }
        if (event.processedAt !== null) {
            Logger.info(`[webhook:${messageId}] Already processed at ${event.processedAt.toISOString()}. Idempotent no-op.`, VIVA_LOG_CONTEXT);
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
        let channelId;
        if (this.options.mode !== 'isv') {
            // Merchant mode: use the default channel. Single-merchant deployments
            // have no per-tenant mapping to perform — the operator may run multiple
            // Vendure channels for catalog/locale split, but Viva traffic belongs
            // to the default channel registered when the plugin was initialized.
            const defaultChannel = await this.channelService.getDefaultChannel(systemCtx);
            channelId = defaultChannel.id;
        }
        else if (merchantId) {
            // ISV mode: check LRU cache first.
            channelId = getCachedChannelId(merchantId);
            if (!channelId) {
                // Linear scan over channels (typically ≤ N=10 channels per deployment)
                const allChannels = await this.channelService.findAll(systemCtx);
                for (const ch of allChannels.items) {
                    const cf = ch.customFields;
                    if (cf && cf['vivaMerchantId'] === merchantId) {
                        channelId = ch.id;
                        setCachedChannelId(merchantId, channelId);
                        break;
                    }
                }
            }
        }
        if (!channelId) {
            // A6 NULL-merchant fallback: set merchantId NULL on row, schedule reprocess with backoff.
            await eventRepo.update({ messageId }, { merchantId: null, error: 'channel-not-found' });
            // Determine which attempt this is (retry_count starts at 0)
            const attemptIndex = event.retryCount;
            if (attemptIndex < A6_BACKOFF_DELAYS_MS.length) {
                const delayMs = A6_BACKOFF_DELAYS_MS[attemptIndex];
                Logger.warn(`[webhook:${messageId}] Channel not found for merchantId=${merchantId ?? 'null'}. Scheduling reprocess attempt ${attemptIndex + 1} in ${delayMs}ms.`, VIVA_LOG_CONTEXT);
                // Increment retry_count on the row
                await eventRepo.increment({ messageId }, 'retryCount', 1);
                // Re-enqueue with backoff (BullMQ delay option)
                await this.queue.add({ messageId }, { retries: 0 });
            }
            else {
                Logger.error(`[webhook:${messageId}] Channel not found after ${attemptIndex} attempts for merchantId=${merchantId ?? 'null'}. Row left stuck — check metrics.`, VIVA_LOG_CONTEXT);
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
                    Logger.info(`[webhook:${messageId}] 1797 Refund Created — audit log only (refund was admin-initiated).`, VIVA_LOG_CONTEXT);
                    await this._markProcessed(eventRepo, messageId);
                    break;
                case 4865:
                    await this._handle4865(ctx, event, eventRepo);
                    break;
                case 8193:
                    // Onboarding lifecycle event — only meaningful in ISV mode (there is
                    // no onboarding flow in merchant mode). Mark processed in both modes
                    // to prevent infinite reprocessing.
                    Logger.info(`[webhook:${messageId}] 8193 Account Connected — analytics, no state change` +
                        `${this.options.mode === 'isv' ? '' : ' (merchant mode: no-op)'}.`, VIVA_LOG_CONTEXT);
                    await this._markProcessed(eventRepo, messageId);
                    break;
                case 8194:
                    if (this.options.mode === 'isv') {
                        await this._handle8194(systemCtx, event, eventRepo);
                    }
                    else {
                        // Merchant mode: no onboarding flip — the merchant configured the
                        // plugin with their own legacyMerchantId / legacyApiKey directly,
                        // so the verification status is moot for plugin behaviour.
                        Logger.info(`[webhook:${messageId}] 8194 Account Verification — merchant mode: no-op.`, VIVA_LOG_CONTEXT);
                        await this._markProcessed(eventRepo, messageId);
                    }
                    break;
                default:
                    Logger.info(`[webhook:${messageId}] Unknown eventTypeId=${event.eventTypeId} — marking processed to prevent infinite reprocessing.`, VIVA_LOG_CONTEXT);
                    await this._markProcessed(eventRepo, messageId);
                    break;
            }
        }
        finally {
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
    async _handle1796(ctx, event, eventRepo) {
        const { messageId } = event;
        const payload = event.payload;
        const eventData = (payload['EventData'] ?? payload);
        const transactionId = (event.transactionId ?? eventData['TransactionId']);
        const merchantId = event.merchantId;
        if (!transactionId) {
            await eventRepo.update({ messageId }, { error: 'missing-transaction-id' });
            Logger.error(`[webhook:${messageId}] 1796: no transactionId in payload.`, VIVA_LOG_CONTEXT);
            return;
        }
        // a. Retrieve transaction from Viva.
        // - ISV mode: pass merchantId from the webhook payload → /isv/transactions/{id}?merchantId=…
        // - Merchant mode: omit merchantId → /transactions/{id} (Payments drops it anyway).
        const isvPayments = this._getIsvPayments();
        let vivaTransaction;
        try {
            const retrieveOpts = this.options.mode === 'isv' && merchantId ? { merchantId } : {};
            vivaTransaction = await isvPayments.retrieveTransaction(transactionId, retrieveOpts);
        }
        catch (err) {
            await eventRepo.update({ messageId }, { error: `retrieve-failed: ${err instanceof Error ? err.message : String(err)}` });
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
        const vivaRow = await txnRepo.findOne({ where: { vivaOrderCode: vivaOrderCodeStr } });
        if (!vivaRow) {
            const errMsg = `viva_transaction row not found for orderCode=${vivaOrderCodeStr}`;
            await eventRepo.update({ messageId }, { error: errMsg });
            Logger.error(`[webhook:${messageId}] 1796: ${errMsg}`, VIVA_LOG_CONTEXT);
            return;
        }
        if (vivaTransaction.statusId !== 'F') {
            const errMsg = `statusId is '${vivaTransaction.statusId}', expected 'F'`;
            await eventRepo.update({ messageId }, { error: errMsg });
            Logger.warn(`[webhook:${messageId}] 1796: ${errMsg} — not settling.`, VIVA_LOG_CONTEXT);
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
        let order = null;
        try {
            const payment = await this.paymentService.findOneOrThrow(ctx, paymentId, ['order']);
            if (payment.order) {
                order = await this.orderService.findOne(ctx, payment.order.id);
            }
        }
        catch {
            // Payment not found
        }
        if (!order) {
            const errMsg = `order not found for paymentId=${String(paymentId)}`;
            await eventRepo.update({ messageId }, { error: errMsg });
            Logger.error(`[webhook:${messageId}] 1796: ${errMsg}`, VIVA_LOG_CONTEXT);
            return;
        }
        // d. Settle based on current order state
        try {
            if (order.state === 'PaymentSettled') {
                // Idempotent no-op
                Logger.info(`[webhook:${messageId}] 1796: order already PaymentSettled — idempotent no-op.`, VIVA_LOG_CONTEXT);
            }
            else if (order.state === 'AddingItems') {
                // Stale-order re-walk
                await this.stateMachine.recoverStaleOrderAndSettle(ctx, order.id, paymentId);
            }
            else if (order.state === 'ArrangingPayment' || order.state === 'PaymentAuthorized') {
                // Normal settle path
                await this.stateMachine.transitionPaymentToSettled(ctx, order.id, paymentId);
            }
            else {
                Logger.warn(`[webhook:${messageId}] 1796: unexpected order state '${order.state}' — attempting settlePayment anyway.`, VIVA_LOG_CONTEXT);
                await this.stateMachine.transitionPaymentToSettled(ctx, order.id, paymentId);
            }
        }
        catch (err) {
            // Fail-loud per Q4: set error, leave processed_at NULL
            const errMsg = err instanceof Error ? err.message : String(err);
            await eventRepo.update({ messageId }, { error: errMsg });
            Logger.error(`[webhook:${messageId}] 1796: transition failed — ${errMsg}`, VIVA_LOG_CONTEXT);
            throw err;
        }
        // e. Update viva_transaction row
        await txnRepo.update({ id: vivaRow.id }, { status: 'captured', vivaTransactionId: transactionId });
        // f. Mark processed
        await this._markProcessed(eventRepo, messageId);
        Logger.info(`[webhook:${messageId}] 1796: settled successfully.`, VIVA_LOG_CONTEXT);
    }
    /**
     * 1798 — Transaction Failed (declined-non-terminal).
     *
     * Mark payment Declined. Leave order in ArrangingPayment (per contract §4).
     * Do NOT auto-rollback to AddingItems — customer retry on same orderCode may succeed.
     */
    async _handle1798(ctx, event, eventRepo) {
        const { messageId } = event;
        const txnRepo = this.connection.rawConnection.getRepository(VivaTransaction);
        // Find viva_transaction by orderCode in payload
        const payload = event.payload;
        const eventData = (payload['EventData'] ?? payload);
        const orderCodeRaw = eventData['OrderCode'];
        const orderCodeStr = orderCodeRaw?.toString();
        if (orderCodeStr) {
            const vivaRow = await txnRepo.findOne({ where: { vivaOrderCode: orderCodeStr } });
            if (vivaRow) {
                await txnRepo.update({ id: vivaRow.id }, { status: 'failed' });
                try {
                    await this.stateMachine.transitionPaymentToDeclined(ctx, vivaRow.paymentId);
                }
                catch (err) {
                    Logger.warn(`[webhook:${messageId}] 1798: could not transition payment to Declined: ${err instanceof Error ? err.message : String(err)}`, VIVA_LOG_CONTEXT);
                    // Non-fatal: the row status is already marked failed
                }
            }
        }
        await this._markProcessed(eventRepo, messageId);
        Logger.info(`[webhook:${messageId}] 1798: payment marked Declined (order stays ArrangingPayment).`, VIVA_LOG_CONTEXT);
    }
    /**
     * 4865 — Order Updated (optional cancel detection).
     *
     * If payload indicates a user-initiated cancel (status suggests cancellation),
     * invoke the cancel flow: cancelled status + Payment Cancelled + Order → AddingItems.
     * Otherwise log + no-op.
     */
    async _handle4865(ctx, event, eventRepo) {
        const { messageId } = event;
        const payload = event.payload;
        const eventData = (payload['EventData'] ?? payload);
        // Viva 4865 payload may contain StatusId or OrderStatus indicating cancellation
        const statusId = eventData['StatusId'];
        const orderCodeRaw = eventData['OrderCode'];
        const orderCodeStr = orderCodeRaw?.toString();
        // Status 'X' or 'F:cancelled' or similar indicates user cancel
        // TODO(impl): confirm exact statusId for user-cancelled in Viva 4865 payload.
        // Based on docs, 'X' means cancelled/expired per wh-transaction-payment-created.txt.
        const isCancelStatus = statusId === 'X' || statusId === 'C' || statusId === 'E';
        if (isCancelStatus && orderCodeStr) {
            const txnRepo = this.connection.rawConnection.getRepository(VivaTransaction);
            const vivaRow = await txnRepo.findOne({ where: { vivaOrderCode: orderCodeStr } });
            if (vivaRow) {
                await txnRepo.update({ id: vivaRow.id }, { status: 'cancelled' });
                try {
                    await this.stateMachine.transitionPaymentToCancelled(ctx, vivaRow.paymentId);
                }
                catch (err) {
                    Logger.warn(`[webhook:${messageId}] 4865: could not cancel payment: ${err instanceof Error ? err.message : String(err)}`, VIVA_LOG_CONTEXT);
                }
                // Transition order back to AddingItems
                try {
                    const payment = await this.paymentService.findOneOrThrow(ctx, vivaRow.paymentId, ['order']);
                    if (payment.order) {
                        await this.orderService.transitionToState(ctx, payment.order.id, 'AddingItems');
                    }
                }
                catch (err) {
                    Logger.warn(`[webhook:${messageId}] 4865: could not transition order to AddingItems: ${err instanceof Error ? err.message : String(err)}`, VIVA_LOG_CONTEXT);
                }
            }
        }
        else {
            Logger.info(`[webhook:${messageId}] 4865 Order Updated — status=${statusId ?? 'unknown'}, no cancel action needed.`, VIVA_LOG_CONTEXT);
        }
        await this._markProcessed(eventRepo, messageId);
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
    async _handle8194(systemCtx, event, eventRepo) {
        const { messageId } = event;
        const accountId = event.accountId;
        if (!accountId) {
            await eventRepo.update({ messageId }, { error: 'missing-account-id' });
            Logger.error(`[webhook:${messageId}] 8194: no accountId in event row.`, VIVA_LOG_CONTEXT);
            return;
        }
        // a. Retrieve connected account from Viva
        const isvAccounts = this._getIsvAccounts();
        let merchantId;
        try {
            const accountInfo = await isvAccounts.retrieveConnectedAccount(accountId);
            // Probe-verified 2026-05-11: `merchantId` is the exact field name (null until verified).
            merchantId = accountInfo.merchantId ?? undefined;
        }
        catch (err) {
            const errMsg = `retrieve-account-failed: ${err instanceof Error ? err.message : String(err)}`;
            await eventRepo.update({ messageId }, { error: errMsg });
            throw err; // Let BullMQ retry
        }
        if (!merchantId) {
            await eventRepo.update({ messageId }, { error: 'merchant-id-not-returned' });
            Logger.warn(`[webhook:${messageId}] 8194: merchantId not in account response — verification may be incomplete.`, VIVA_LOG_CONTEXT);
            return;
        }
        // b. Find channel by vivaAccountId
        const channel = await this.connectedAccounts.findChannelByAccountId(accountId);
        if (!channel) {
            await eventRepo.update({ messageId }, { error: `channel-not-found-for-accountId:${accountId}` });
            Logger.error(`[webhook:${messageId}] 8194: no channel found for accountId=${accountId}.`, VIVA_LOG_CONTEXT);
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
        Logger.info(`[webhook:${messageId}] 8194: channel ${String(channel.id)} now has merchantId=${merchantId} and payoutsEnabled=true.`, VIVA_LOG_CONTEXT);
    }
    // ---------------------------------------------------------------------------
    // Helpers
    // ---------------------------------------------------------------------------
    async _markProcessed(eventRepo, messageId) {
        await eventRepo.update({ messageId }, { processedAt: new Date(), error: null });
    }
    async _loadChannel(channelId) {
        // Build a system-level ctx to load the channel object
        const sysCtx = await this.requestContextService.create({ apiType: 'admin' });
        return this.channelService.findOne(sysCtx, channelId);
    }
    _getIsvPayments() {
        const client = new IsvHttpClient({
            environment: this.options.environment,
            authStrategy: this.oauth2,
        });
        return new Payments({ mode: this.options.mode, client });
    }
    _getIsvAccounts() {
        const client = new IsvHttpClient({
            environment: this.options.environment,
            authStrategy: this.oauth2,
        });
        return new IsvAccounts(client);
    }
};
ProcessVivaWebhookHandler = __decorate([
    Injectable(),
    __param(9, Inject(VIVA_PLUGIN_OPTIONS)),
    __param(10, Inject(VIVA_OAUTH2_STRATEGY_TOKEN)),
    __metadata("design:paramtypes", [JobQueueService,
        TransactionalConnection,
        StateMachineService,
        PerMerchantSemaphore,
        ConnectedAccountsService,
        OrderService,
        PaymentService,
        ChannelService,
        RequestContextService, Object, Object])
], ProcessVivaWebhookHandler);
export { ProcessVivaWebhookHandler };
//# sourceMappingURL=process-viva-webhook.handler.js.map