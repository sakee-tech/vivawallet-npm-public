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
import type { OnApplicationBootstrap, OnApplicationShutdown } from '@nestjs/common';
import { JobQueueService, TransactionalConnection, RequestContextService, OrderService, ChannelService, PaymentService, EventBus, ProcessContext } from '@vendure/core';
import type { VivaPaymentPluginOptions } from '../types.js';
import type { VivaOAuth2Strategy } from '../providers/viva-oauth2-strategy.provider.js';
import { StateMachineService } from '../services/state-machine.service.js';
import { PerMerchantSemaphore } from '../services/per-merchant-semaphore.service.js';
import { ConnectedAccountsService } from '../services/connected-accounts.service.js';
export declare const A6_CHANNEL_NOT_FOUND = "channel-not-found";
export declare const A6_CHANNEL_NOT_FOUND_EXHAUSTED = "channel-not-found-exhausted";
/**
 * A6 retry `n` (1-based = row.retryCount) is due at
 * `receivedAt + sum(A6_BACKOFF_DELAYS_MS[0..n-1])`. Derived from columns that
 * already exist — no `next_attempt_at` column, no in-process timer to lose on
 * restart.
 */
export declare function a6RetryDueAt(receivedAt: Date, retryCount: number): Date;
export declare class ProcessVivaWebhookHandler implements OnApplicationBootstrap, OnApplicationShutdown {
    private readonly jobQueueService;
    private readonly connection;
    private readonly stateMachine;
    private readonly semaphore;
    private readonly connectedAccounts;
    private readonly orderService;
    private readonly paymentService;
    private readonly channelService;
    private readonly requestContextService;
    private readonly eventBus;
    private readonly processContext;
    private readonly options;
    private readonly oauth2;
    private queue;
    private _a6Timer;
    constructor(jobQueueService: JobQueueService, connection: TransactionalConnection, stateMachine: StateMachineService, semaphore: PerMerchantSemaphore, connectedAccounts: ConnectedAccountsService, orderService: OrderService, paymentService: PaymentService, channelService: ChannelService, requestContextService: RequestContextService, eventBus: EventBus, processContext: ProcessContext, options: VivaPaymentPluginOptions, oauth2: VivaOAuth2Strategy);
    onApplicationBootstrap(): Promise<void>;
    onApplicationShutdown(): void;
    /**
     * Re-enqueue A6 "channel not found" rows whose backoff has elapsed.
     * Returns the number of jobs enqueued. Exposed for tests.
     */
    sweepChannelNotFound(now?: Date): Promise<number>;
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
     *
     * SECURITY (CSO-Finding-1, same class as 1796): the order is resolved by the
     * orderCode returned from an AUTHENTICATED retrieveTransaction call keyed on
     * the envelope TransactionId — NOT by the envelope OrderCode, which is
     * attacker-controlled. Trusting the envelope OrderCode here would let anyone
     * past the IP allowlist force-decline an arbitrary order.
     */
    private _handle1798;
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
    private _handle1797;
    /**
     * 1797: run `check` in a transaction. A throw writes `{label}: describeError`
     * to the event's error column and rethrows; 'absent' writes
     * `refund-not-listed-yet` and throws (a webhook never fails a refund: the
     * listing may lag). Either way BullMQ retries. Else the event is processed.
     */
    private _check1797;
    /**
     * #31: 1797 matching no Pending refund (MerchantTrns null or unknown) → a
     * refund made outside Vendure, recorded on the payment's row from Viva's
     * authenticated listing (`recordExternalRefund`), then `VivaExternalRefundEvent`.
     * Not listed yet / listing fails → throw so BullMQ retries. Replay, or a
     * refund Vendure already has → no-op, no event.
     */
    private _recordExternalRefund;
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
    private _handle4865;
    /**
     * Authenticated transaction fetch shared by the settle/decline/cancel paths.
     * The returned `orderCode`/`statusId` are trustworthy (Viva-signed via OAuth2),
     * unlike the webhook envelope. ISV mode scopes by the row's merchantId.
     */
    private _retrieveAuthoritative;
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