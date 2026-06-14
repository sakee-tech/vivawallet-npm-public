/**
 * services/state-machine.service.ts — Low-level VivaTransaction row helpers
 * AND Vendure order/payment transition wrappers (V7 extension).
 *
 * Row helpers: INSERT-OR-NOTHING idempotent writes + lookups for VivaTransaction.
 * Transition helpers: wraps OrderService + PaymentService state-machine calls;
 *   used exclusively by the webhook worker (V7). Implements the stale-recovery
 *   re-walk (AddingItems → ArrangingPayment → PaymentAuthorized → PaymentSettled)
 *   with fail-loud semantics per Q4 decision.
 *
 * Repository injection via Vendure's TransactionalConnection.
 *
 * @see docs/plans/vendure-plugin-v0.md §"Build Plan — V5 + V7"
 * @see docs/plans/vendure-plugin-v0.md §D6 (state transitions via OrderService)
 * @see docs/plans/vendure-plugin-v0.md §D11 (idempotency)
 */
import { TransactionalConnection, OrderService, PaymentService } from '@vendure/core';
import type { RequestContext } from '@vendure/core';
import { VivaTransaction } from '../entities/viva-transaction.entity.js';
import type { VivaTransactionStatus } from '../entities/viva-transaction.entity.js';
export interface UpsertPendingInput {
    channelId: string | number;
    paymentId: string | number;
    idempotencyKey: string;
    amountMinor: bigint;
    currencyCode: string;
    isvAmountMinor: bigint;
}
export declare class StateMachineService {
    private readonly connection;
    private readonly orderService;
    private readonly paymentService;
    constructor(connection: TransactionalConnection, orderService: OrderService, paymentService: PaymentService);
    /**
     * Load a VivaTransaction row by (channelId, paymentId).
     * Returns null if not found.
     */
    getVivaTransaction(ctx: RequestContext, channelId: string | number, paymentId: string | number): Promise<VivaTransaction | null>;
    /**
     * Reconcile a pending row's `paymentId` from the createPayment proxy value
     * (the order id, written because Vendure assigns the real Payment.id only
     * AFTER the handler returns — see payment-method-handler.createPayment) to the
     * real Payment.id.
     *
     * The row is located by its globally-unique `vivaOrderCode` (NOT the proxy
     * paymentId), so exactly one row is targeted with no id-collision risk. This
     * is invoked from the viva PaymentProcess.onTransitionStart once the real
     * Payment.id exists, which makes EVERY later lookup keyed on Payment.id resolve
     * — cancelPayment (resolver + handler), settlePayment, createRefund, and the
     * webhook settle path (which reads `vivaRow.paymentId` as a Payment id).
     *
     * Without it, those lookups only worked when `order.id === payment.id` (true
     * in fresh test DBs, false in production), so the whole post-create lifecycle
     * silently broke. See sakee-tech/vivawallet-npm-public#13.
     *
     * Idempotent: re-setting the same value updates 0 rows. Returns rows affected.
     */
    reconcilePaymentId(ctx: RequestContext, vivaOrderCode: string, realPaymentId: string | number): Promise<number>;
    /**
     * INSERT-OR-NOTHING write of a pending VivaTransaction row.
     *
     * Idempotency key D11: keyed on (channelId, paymentId).
     * If a row already exists with the same key and a non-null vivaOrderCode,
     * returns that existing row so the handler can skip the Viva API call.
     *
     * Returns: { row, wasInserted }
     *   wasInserted=true  → freshly inserted; handler must call Viva.
     *   wasInserted=false → already existed; check row.vivaOrderCode.
     */
    upsertPendingTransaction(ctx: RequestContext, input: UpsertPendingInput): Promise<{
        row: VivaTransaction;
        wasInserted: boolean;
    }>;
    /**
     * Update the vivaOrderCode on a pending row after createOrder succeeds.
     */
    setOrderCode(ctx: RequestContext, rowId: string | number, vivaOrderCode: string, metadata: Record<string, unknown>): Promise<void>;
    /**
     * Update row status (e.g. pending → captured, pending → cancelled).
     */
    setStatus(ctx: RequestContext, rowId: string | number, status: VivaTransactionStatus, metadata?: Record<string, unknown>): Promise<void>;
    /**
     * Transition a Payment to `Settled` via `PaymentService.transitionToState`.
     *
     * Vendure's canonical path for webhook-driven settlement.
     * @see docs/plans/vendure-plugin-v0.md §D6, §D5 (1796 settle path)
     */
    transitionPaymentToSettled(ctx: RequestContext, orderId: string | number, paymentId: string | number): Promise<void>;
    /**
     * Transition a Payment to `Declined` via `PaymentService.transitionToState`.
     *
     * Called on webhook 1798 (Transaction Failed). Order stays in ArrangingPayment.
     * @see docs/plans/vendure-plugin-v0.md §D5 (1798 path)
     */
    transitionPaymentToDeclined(ctx: RequestContext, paymentId: string | number): Promise<void>;
    /**
     * Transition a Payment to `Cancelled` via `PaymentService.transitionToState`.
     *
     * Called on webhook 4865 user-cancel detection.
     * @see docs/plans/vendure-plugin-v0.md §D5 (4865 path)
     */
    transitionPaymentToCancelled(ctx: RequestContext, paymentId: string | number): Promise<void>;
    /**
     * Stale-order re-walk: AddingItems → ArrangingPayment → PaymentSettled.
     *
     * Implements the Q4 decision: fail-loud on any transition failure — log an
     * ERROR-level message, throw, let the webhook row stay unprocessed. The
     * storefront will surface "basket changed" via the live order state.
     *
     * Sequence:
     *   1. AddingItems → ArrangingPayment    (transitionOrderToState)
     *   2. ArrangingPayment → settlePayment  (OrderService.settlePayment)
     *
     * @see docs/plans/vendure-plugin-v0.md §"Process flow" step 4e
     * @see docs/plans/vendure-plugin-v0.md §"Architecture Decisions Q4"
     */
    recoverStaleOrderAndSettle(ctx: RequestContext, orderId: string | number, paymentId: string | number): Promise<void>;
    private _isDuplicateKeyError;
}
//# sourceMappingURL=state-machine.service.d.ts.map