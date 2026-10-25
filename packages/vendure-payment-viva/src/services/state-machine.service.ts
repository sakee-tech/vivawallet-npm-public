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

import { Injectable, Logger as NestLogger } from '@nestjs/common';
import { TransactionalConnection, Logger, OrderService, PaymentService, Refund } from '@vendure/core';
import type { ID, RequestContext, Payment } from '@vendure/core';
import { QueryFailedError } from 'typeorm';
import { VivaTransaction } from '../entities/viva-transaction.entity.js';
import type { VivaTransactionStatus } from '../entities/viva-transaction.entity.js';
import { VIVA_LOG_CONTEXT } from '../constants.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface UpsertPendingInput {
  channelId: string | number;
  paymentId: string | number;
  idempotencyKey: string;
  amountMinor: bigint;
  currencyCode: string;
  isvAmountMinor: bigint;
}

/**
 * #2 "refund started" note, kept at `viva_transaction.metadata.refundAttempt`.
 * One per payment: a `started` note means a Viva refund call may have moved
 * money while Vendure rolled back; createRefund reconciles it before resending.
 */
export interface RefundAttemptNote {
  key: string;
  amountMinor: number;
  startedAt: string;
  state: 'started' | 'done';
}

const REFUND_NOTE_LOCK_TIMEOUT = '3s';

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

@Injectable()
export class StateMachineService {
  constructor(
    private readonly connection: TransactionalConnection,
    private readonly orderService: OrderService,
    private readonly paymentService: PaymentService,
  ) {}

  /**
   * Load a VivaTransaction row by (channelId, paymentId).
   * Returns null if not found.
   */
  async getVivaTransaction(
    ctx: RequestContext,
    channelId: string | number,
    paymentId: string | number,
  ): Promise<VivaTransaction | null> {
    const repo = this.connection.getRepository(ctx, VivaTransaction);
    return repo.findOne({
      where: { channelId: channelId as any, paymentId: paymentId as any },
    });
  }

  /**
   * Sum of this Payment's Settled Vendure Refunds (minor units) — the
   * "refunded before" input to the #2 refund idempotency key.
   *
   * Read through `ctx` so it sees the caller's open transaction: a Refund
   * rolled back with it never counts (retry → same key → Viva dedupes), while
   * a Refund saved earlier in the same transaction (multi-target refundOrder)
   * does — the in-memory `payment.refunds` Vendure passes the handler is
   * loaded once per refundOrder call and would miss it. The Refund being
   * created is not saved until the handler returns, so it is excluded.
   */
  async getSettledRefundTotal(ctx: RequestContext, paymentId: ID): Promise<number> {
    const refunds = await this.getSettledRefunds(ctx, paymentId);
    return refunds.reduce((sum, r) => sum + r.total, 0);
  }

  /** This Payment's Settled Vendure Refunds, read through `ctx` (see above). */
  getSettledRefunds(ctx: RequestContext, paymentId: ID): Promise<Refund[]> {
    return this.connection.getRepository(ctx, Refund).find({ where: { paymentId, state: 'Settled' } });
  }

  /**
   * #2: write `metadata.refundAttempt` and COMMIT it in its OWN transaction on
   * the raw connection — never through `ctx`, whose transaction a failed
   * COMMIT rolls back (that is exactly the crash this note must survive). Only
   * the `refundAttempt` key is touched (jsonb_set), so other metadata is safe.
   *
   * lock_timeout: if the caller's transaction already UPDATEd this row (e.g.
   * two refunds of one payment in one transaction), this second connection
   * would wait on that row lock while the caller waits on us — a hang. Fail
   * fast instead; the handler refuses the refund.
   */
  async commitRefundNote(rowId: ID, note: RefundAttemptNote): Promise<void> {
    await this.connection.rawConnection.transaction(async (em) => {
      await em.query(`SET LOCAL lock_timeout = '${REFUND_NOTE_LOCK_TIMEOUT}'`);
      await em
        .createQueryBuilder()
        .update(VivaTransaction)
        .set({
          metadata: () => `jsonb_set(COALESCE("metadata", CAST('{}' AS jsonb)), '{refundAttempt}', CAST(:note AS jsonb))`,
        } as any)
        .where('id = :id', { id: rowId })
        .setParameter('note', JSON.stringify(note))
        .execute();
    });
  }

  /**
   * Load a VivaTransaction row by its globally-unique `vivaOrderCode`.
   * Returns null if not found. Used by the `orderByVivaReturn` Shop API query to
   * resolve a Smart Checkout return (?s=<vivaOrderCode>) to its Vendure order via
   * the unique index `idx_viva_transaction_order_code` — no ISV API call.
   */
  async getVivaTransactionByOrderCode(
    ctx: RequestContext,
    vivaOrderCode: string,
  ): Promise<VivaTransaction | null> {
    const repo = this.connection.getRepository(ctx, VivaTransaction);
    return repo.findOne({ where: { vivaOrderCode } as any });
  }

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
  async reconcilePaymentId(
    ctx: RequestContext,
    vivaOrderCode: string,
    realPaymentId: string | number,
  ): Promise<number> {
    const repo = this.connection.getRepository(ctx, VivaTransaction);
    const result = await repo.update(
      { vivaOrderCode } as any,
      { paymentId: realPaymentId } as any,
    );
    return result.affected ?? 0;
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
  async upsertPendingTransaction(
    ctx: RequestContext,
    input: UpsertPendingInput,
  ): Promise<{ row: VivaTransaction; wasInserted: boolean }> {
    const repo = this.connection.getRepository(ctx, VivaTransaction);

    // Check if already exists
    const existing = await repo.findOne({
      where: {
        channelId: input.channelId as any,
        paymentId: input.paymentId as any,
      },
    });

    if (existing) {
      return { row: existing, wasInserted: false };
    }

    // Try to INSERT; handle race condition via duplicate-key error.
    const row = repo.create({
      channelId: input.channelId as any,
      paymentId: input.paymentId as any,
      status: 'pending' as VivaTransactionStatus,
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
    } catch (err) {
      // Duplicate key: another request beat us to the insert (race).
      if (err instanceof QueryFailedError && this._isDuplicateKeyError(err)) {
        const existing2 = await repo.findOne({
          where: {
            channelId: input.channelId as any,
            paymentId: input.paymentId as any,
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
  async setOrderCode(
    ctx: RequestContext,
    rowId: string | number,
    vivaOrderCode: string,
    metadata: Record<string, unknown>,
  ): Promise<void> {
    const repo = this.connection.getRepository(ctx, VivaTransaction);
    // Use query builder to avoid exactOptionalPropertyTypes issues with TypeORM _QueryDeepPartialEntity.
    await repo
      .createQueryBuilder()
      .update(VivaTransaction)
      .set({ vivaOrderCode, metadata: () => ':meta' as any } as any)
      .where('id = :id', { id: rowId })
      .setParameter('meta', JSON.stringify(metadata))
      .execute();
  }

  /**
   * Update row status (e.g. pending → captured, pending → cancelled).
   */
  async setStatus(
    ctx: RequestContext,
    rowId: string | number,
    status: VivaTransactionStatus,
    metadata?: Record<string, unknown>,
  ): Promise<void> {
    const repo = this.connection.getRepository(ctx, VivaTransaction);
    if (metadata !== undefined) {
      await repo
        .createQueryBuilder()
        .update(VivaTransaction)
        .set({ status, metadata: () => ':meta' as any } as any)
        .where('id = :id', { id: rowId })
        .setParameter('meta', JSON.stringify(metadata))
        .execute();
    } else {
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
  async transitionPaymentToSettled(
    ctx: RequestContext,
    orderId: string | number,
    paymentId: string | number,
  ): Promise<void> {
    // Vendure state machine: Created → Authorized → Settled
    // OrderService.settlePayment handles the two-step transition internally.
    const result = await this.orderService.settlePayment(ctx, paymentId as any);
    if ('errorCode' in result) {
      throw new Error(
        `[StateMachineService] settlePayment failed: ${String((result as any).errorCode)}`,
      );
    }
  }

  /**
   * Transition a Payment to `Declined` via `PaymentService.transitionToState`.
   *
   * Called on webhook 1798 (Transaction Failed). Order stays in ArrangingPayment.
   * @see docs/plans/vendure-plugin-v0.md §D5 (1798 path)
   */
  async transitionPaymentToDeclined(
    ctx: RequestContext,
    paymentId: string | number,
  ): Promise<void> {
    await this.paymentService.transitionToState(ctx, paymentId as any, 'Declined');
  }

  /**
   * Transition a Payment to `Cancelled` via `PaymentService.transitionToState`.
   *
   * Called on webhook 4865 user-cancel detection.
   * @see docs/plans/vendure-plugin-v0.md §D5 (4865 path)
   */
  async transitionPaymentToCancelled(
    ctx: RequestContext,
    paymentId: string | number,
  ): Promise<void> {
    await this.paymentService.transitionToState(ctx, paymentId as any, 'Cancelled');
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
  async recoverStaleOrderAndSettle(
    ctx: RequestContext,
    orderId: string | number,
    paymentId: string | number,
  ): Promise<void> {
    Logger.info(
      '[StateMachineService] Starting stale-order re-walk.',
      VIVA_LOG_CONTEXT,
    );

    // Step 1: AddingItems → ArrangingPayment
    const transitionResult = await this.orderService.transitionToState(ctx, orderId as any, 'ArrangingPayment');
    if ('errorCode' in transitionResult) {
      const msg = `[StateMachineService] Stale re-walk FAILED on AddingItems→ArrangingPayment: ${String((transitionResult as any).errorCode)}`;
      Logger.error(
        `[StateMachineService] Stale re-walk FAILED on AddingItems→ArrangingPayment: ${String((transitionResult as any).errorCode)}`,
        VIVA_LOG_CONTEXT,
      );
      throw new Error(msg);
    }

    // Step 2: ArrangingPayment → settle (Created → Authorized → Settled)
    const settleResult = await this.orderService.settlePayment(ctx, paymentId as any);
    if ('errorCode' in settleResult) {
      const msg = `[StateMachineService] Stale re-walk FAILED on settlePayment: ${String((settleResult as any).errorCode)}`;
      Logger.error(
        `[StateMachineService] Stale re-walk FAILED on settlePayment: ${String((settleResult as any).errorCode)}`,
        VIVA_LOG_CONTEXT,
      );
      throw new Error(msg);
    }

    Logger.info(
      '[StateMachineService] Stale re-walk complete: order now PaymentSettled.',
      VIVA_LOG_CONTEXT,
    );
  }

  // ---------------------------------------------------------------------------
  // Private helpers
  // ---------------------------------------------------------------------------

  private _isDuplicateKeyError(err: QueryFailedError): boolean {
    const msg = (err as QueryFailedError & { code?: string }).code ?? '';
    // Postgres unique violation
    if (msg === '23505') return true;
    // SQLite UNIQUE constraint
    if (err.message.toLowerCase().includes('unique')) return true;
    return false;
  }
}
