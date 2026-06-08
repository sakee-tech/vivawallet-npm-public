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
import type { OnApplicationBootstrap } from '@nestjs/common';
import { JobQueueService, TransactionalConnection, RequestContextService, OrderService, ChannelService, PaymentService } from '@vendure/core';
import type { VivaPaymentPluginOptions } from '../types.js';
import type { VivaOAuth2Strategy } from '../providers/viva-oauth2-strategy.provider.js';
import { StateMachineService } from '../services/state-machine.service.js';
import { PerMerchantSemaphore } from '../services/per-merchant-semaphore.service.js';
import { ConnectedAccountsService } from '../services/connected-accounts.service.js';
import type { ProcessVivaWebhookJobData } from './queue-names.js';
export declare class ProcessVivaWebhookHandler implements OnApplicationBootstrap {
    private readonly jobQueueService;
    private readonly connection;
    private readonly stateMachine;
    private readonly semaphore;
    private readonly connectedAccounts;
    private readonly orderService;
    private readonly paymentService;
    private readonly channelService;
    private readonly requestContextService;
    private readonly options;
    private readonly oauth2;
    private queue;
    constructor(jobQueueService: JobQueueService, connection: TransactionalConnection, stateMachine: StateMachineService, semaphore: PerMerchantSemaphore, connectedAccounts: ConnectedAccountsService, orderService: OrderService, paymentService: PaymentService, channelService: ChannelService, requestContextService: RequestContextService, options: VivaPaymentPluginOptions, oauth2: VivaOAuth2Strategy);
    onApplicationBootstrap(): Promise<void>;
    /**
     * Enqueue a new webhook processing job.
     * Called by the webhook controller (V6) after INSERT-OR-NOTHING succeeds.
     */
    enqueue(data: ProcessVivaWebhookJobData, delayMs?: number): Promise<void>;
    private _processJob;
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
    private _handle1796;
    /**
     * 1798 — Transaction Failed (declined-non-terminal).
     *
     * Mark payment Declined. Leave order in ArrangingPayment (per contract §4).
     * Do NOT auto-rollback to AddingItems — customer retry on same orderCode may succeed.
     */
    private _handle1798;
    /**
     * 4865 — Order Updated (optional cancel detection).
     *
     * If payload indicates a user-initiated cancel (status suggests cancellation),
     * invoke the cancel flow: cancelled status + Payment Cancelled + Order → AddingItems.
     * Otherwise log + no-op.
     */
    private _handle4865;
    /**
     * 8194 — Account Verification Status Changed (THE gating signal).
     *
     * a. Retrieve connected account from Viva to get merchantId.
     * b. Find channel by vivaAccountId.
     * c. WRITE ORDER (mandatory per contract §10):
     *    i.  Write vivaMerchantId FIRST.
     *    ii. Write vivaPayoutsEnabled=true LAST.
     */
    private _handle8194;
    private _markProcessed;
    private _loadChannel;
    private _getIsvPayments;
    private _getIsvAccounts;
}
//# sourceMappingURL=process-viva-webhook.handler.d.ts.map