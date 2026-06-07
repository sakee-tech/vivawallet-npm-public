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
var __decorate = (this && this.__decorate) || function (decorators, target, key, desc) {
    var c = arguments.length, r = c < 3 ? target : desc === null ? desc = Object.getOwnPropertyDescriptor(target, key) : desc, d;
    if (typeof Reflect === "object" && typeof Reflect.decorate === "function") r = Reflect.decorate(decorators, target, key, desc);
    else for (var i = decorators.length - 1; i >= 0; i--) if (d = decorators[i]) r = (c < 3 ? d(r) : c > 3 ? d(target, key, r) : d(target, key)) || r;
    return c > 3 && r && Object.defineProperty(target, key, r), r;
};
var __metadata = (this && this.__metadata) || function (k, v) {
    if (typeof Reflect === "object" && typeof Reflect.metadata === "function") return Reflect.metadata(k, v);
};
import { Injectable, Logger as NestLogger } from '@nestjs/common';
import { TransactionalConnection, Logger, OrderService, PaymentService } from '@vendure/core';
import { QueryFailedError } from 'typeorm';
import { VivaTransaction } from '../entities/viva-transaction.entity.js';
import { VIVA_LOG_CONTEXT } from '../constants.js';
// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------
let StateMachineService = class StateMachineService {
    connection;
    orderService;
    paymentService;
    constructor(connection, orderService, paymentService) {
        this.connection = connection;
        this.orderService = orderService;
        this.paymentService = paymentService;
    }
    /**
     * Load a VivaTransaction row by (channelId, paymentId).
     * Returns null if not found.
     */
    async getVivaTransaction(ctx, channelId, paymentId) {
        const repo = this.connection.getRepository(ctx, VivaTransaction);
        return repo.findOne({
            where: { channelId: channelId, paymentId: paymentId },
        });
    }
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
    async upsertPendingTransaction(ctx, input) {
        const repo = this.connection.getRepository(ctx, VivaTransaction);
        // Check if already exists
        const existing = await repo.findOne({
            where: {
                channelId: input.channelId,
                paymentId: input.paymentId,
            },
        });
        if (existing) {
            return { row: existing, wasInserted: false };
        }
        // Try to INSERT; handle race condition via duplicate-key error.
        const row = repo.create({
            channelId: input.channelId,
            paymentId: input.paymentId,
            status: 'pending',
            vivaOrderCode: null,
            vivaTransactionId: null,
            amountMinor: input.amountMinor.toString(),
            currencyCode: input.currencyCode,
            isvAmountMinor: input.isvAmountMinor.toString(),
            metadata: { idempotencyKey: input.idempotencyKey },
        });
        try {
            const saved = await repo.save(row);
            return { row: saved, wasInserted: true };
        }
        catch (err) {
            // Duplicate key: another request beat us to the insert (race).
            if (err instanceof QueryFailedError && this._isDuplicateKeyError(err)) {
                const existing2 = await repo.findOne({
                    where: {
                        channelId: input.channelId,
                        paymentId: input.paymentId,
                    },
                });
                if (existing2) {
                    return { row: existing2, wasInserted: false };
                }
            }
            throw err;
        }
    }
    /**
     * Update the vivaOrderCode on a pending row after createOrder succeeds.
     */
    async setOrderCode(ctx, rowId, vivaOrderCode, metadata) {
        const repo = this.connection.getRepository(ctx, VivaTransaction);
        // Use query builder to avoid exactOptionalPropertyTypes issues with TypeORM _QueryDeepPartialEntity.
        await repo
            .createQueryBuilder()
            .update(VivaTransaction)
            .set({ vivaOrderCode, metadata: () => ':meta' })
            .where('id = :id', { id: rowId })
            .setParameter('meta', JSON.stringify(metadata))
            .execute();
    }
    /**
     * Update row status (e.g. pending → captured, pending → cancelled).
     */
    async setStatus(ctx, rowId, status, metadata) {
        const repo = this.connection.getRepository(ctx, VivaTransaction);
        if (metadata !== undefined) {
            await repo
                .createQueryBuilder()
                .update(VivaTransaction)
                .set({ status, metadata: () => ':meta' })
                .where('id = :id', { id: rowId })
                .setParameter('meta', JSON.stringify(metadata))
                .execute();
        }
        else {
            await repo
                .createQueryBuilder()
                .update(VivaTransaction)
                .set({ status })
                .where('id = :id', { id: rowId })
                .execute();
        }
    }
    // ---------------------------------------------------------------------------
    // Order / Payment transition helpers (V7)
    // ---------------------------------------------------------------------------
    /**
     * Transition a Payment to `Settled` via `PaymentService.transitionToState`.
     *
     * Vendure's canonical path for webhook-driven settlement.
     * @see docs/plans/vendure-plugin-v0.md §D6, §D5 (1796 settle path)
     */
    async transitionPaymentToSettled(ctx, orderId, paymentId) {
        // Vendure state machine: Created → Authorized → Settled
        // OrderService.settlePayment handles the two-step transition internally.
        const result = await this.orderService.settlePayment(ctx, paymentId);
        if ('errorCode' in result) {
            throw new Error(`[StateMachineService] Failed to settle payment ${String(paymentId)} for order ${String(orderId)}: ${result.message ?? JSON.stringify(result)}`);
        }
    }
    /**
     * Transition a Payment to `Declined` via `PaymentService.transitionToState`.
     *
     * Called on webhook 1798 (Transaction Failed). Order stays in ArrangingPayment.
     * @see docs/plans/vendure-plugin-v0.md §D5 (1798 path)
     */
    async transitionPaymentToDeclined(ctx, paymentId) {
        await this.paymentService.transitionToState(ctx, paymentId, 'Declined');
    }
    /**
     * Transition a Payment to `Cancelled` via `PaymentService.transitionToState`.
     *
     * Called on webhook 4865 user-cancel detection.
     * @see docs/plans/vendure-plugin-v0.md §D5 (4865 path)
     */
    async transitionPaymentToCancelled(ctx, paymentId) {
        await this.paymentService.transitionToState(ctx, paymentId, 'Cancelled');
    }
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
    async recoverStaleOrderAndSettle(ctx, orderId, paymentId) {
        Logger.info(`[StateMachineService] Starting stale-order re-walk for order ${String(orderId)}, payment ${String(paymentId)}.`, VIVA_LOG_CONTEXT);
        // Step 1: AddingItems → ArrangingPayment
        const transitionResult = await this.orderService.transitionToState(ctx, orderId, 'ArrangingPayment');
        if ('errorCode' in transitionResult) {
            const msg = `[StateMachineService] Stale re-walk FAILED on AddingItems→ArrangingPayment for order ${String(orderId)}: ${transitionResult.message ?? JSON.stringify(transitionResult)}`;
            Logger.error(msg, VIVA_LOG_CONTEXT);
            throw new Error(msg);
        }
        // Step 2: ArrangingPayment → settle (Created → Authorized → Settled)
        const settleResult = await this.orderService.settlePayment(ctx, paymentId);
        if ('errorCode' in settleResult) {
            const msg = `[StateMachineService] Stale re-walk FAILED on settlePayment for order ${String(orderId)}, payment ${String(paymentId)}: ${settleResult.message ?? JSON.stringify(settleResult)}`;
            Logger.error(msg, VIVA_LOG_CONTEXT);
            throw new Error(msg);
        }
        Logger.info(`[StateMachineService] Stale re-walk complete: order ${String(orderId)} now PaymentSettled.`, VIVA_LOG_CONTEXT);
    }
    // ---------------------------------------------------------------------------
    // Private helpers
    // ---------------------------------------------------------------------------
    _isDuplicateKeyError(err) {
        const msg = err.code ?? '';
        // Postgres unique violation
        if (msg === '23505')
            return true;
        // SQLite UNIQUE constraint
        if (err.message.toLowerCase().includes('unique'))
            return true;
        return false;
    }
};
StateMachineService = __decorate([
    Injectable(),
    __metadata("design:paramtypes", [TransactionalConnection,
        OrderService,
        PaymentService])
], StateMachineService);
export { StateMachineService };
//# sourceMappingURL=state-machine.service.js.map