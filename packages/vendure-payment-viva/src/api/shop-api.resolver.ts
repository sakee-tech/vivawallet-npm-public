/**
 * api/shop-api.resolver.ts — VivaShopApiResolver
 *
 * Resolves the `cancelPayment(paymentId)` Shop API mutation.
 *
 * Authorization pattern (D5 + D8, §3 cancel ownership):
 *   - Authenticated customer: ctx.activeUserId must match order.customer.user.id.
 *   - Anonymous order: the session's active order (looked up via
 *     OrderService.getActiveOrderForUser or by active-order token) must have the
 *     same id as the payment's order. We load the active order for the current
 *     session (ctx) and compare order ids — if they match, the caller owns it.
 *   Returns CancelPaymentError { errorCode: 'AUTHORIZATION_FAILED' } when neither
 *   condition is satisfied. Does NOT throw — returns the union error member per
 *   Vendure GraphQL conventions.
 *
 * Idempotency on re-cancel:
 *   The row-status guard (step 6) fires before the Viva DELETE call.
 *   If viva_transaction.status is already 'cancelled', we return
 *   CancelPaymentError('VIVA_PAYMENT_NOT_CANCELLABLE') immediately — no Viva
 *   network call is made. If the row is NOT yet 'cancelled' but Viva 4xx with
 *   "already cancelled", the handler's error map converts it to
 *   CancelPaymentError('VIVA_API_ERROR'). Both paths are tested.
 *
 * @see docs/plans/vendure-plugin-v0.md §"API Surface — Shop API extension"
 * @see docs/plans/vendure-plugin-v0.md §"Build Plan — V8"
 * @see docs/plans/vendure-plugin-v0.md §D5, §D8
 * @see docs/VENDURE-CONTRACT.MD §3
 */

import { Resolver, Mutation, Args } from '@nestjs/graphql';
import { Inject } from '@nestjs/common';
import {
  Ctx,
  RequestContext,
  OrderService,
  PaymentService,
  TransactionalConnection,
  Logger,
  isGraphQlErrorResult,
} from '@vendure/core';
import type { Payment, Order } from '@vendure/core';
import { StateMachineService } from '../services/state-machine.service.js';
import { VivaPluginError } from '../util/error-envelope.js';
import { VIVA_PLUGIN_OPTIONS, VIVA_LOG_CONTEXT } from '../constants.js';
import type { VivaPaymentPluginOptions } from '../types.js';

// ---------------------------------------------------------------------------
// Terminal statuses that cannot be cancelled
// ---------------------------------------------------------------------------

const TERMINAL_STATUSES = new Set(['captured', 'refunded', 'partially_refunded', 'failed', 'cancelled']);

// ---------------------------------------------------------------------------
// GraphQL union return types (plain objects with __typename for Vendure)
// ---------------------------------------------------------------------------

function cancelPaymentError(opts: {
  errorCode: string;
  message: string;
  vivaErrorCode?: number;
  vivaErrorMessage?: string;
}): object {
  return {
    __typename: 'CancelPaymentError',
    errorCode: opts.errorCode,
    message: opts.message,
    ...(opts.vivaErrorCode !== undefined ? { vivaErrorCode: opts.vivaErrorCode } : {}),
    ...(opts.vivaErrorMessage !== undefined ? { vivaErrorMessage: opts.vivaErrorMessage } : {}),
  };
}

// ---------------------------------------------------------------------------
// Resolver
// ---------------------------------------------------------------------------

@Resolver()
export class VivaShopApiResolver {
  constructor(
    private readonly orderService: OrderService,
    private readonly paymentService: PaymentService,
    private readonly connection: TransactionalConnection,
    private readonly stateMachine: StateMachineService,
    @Inject(VIVA_PLUGIN_OPTIONS) private readonly options: VivaPaymentPluginOptions,
  ) {}

  @Mutation()
  async cancelPayment(
    @Args('paymentId') paymentId: string,
    @Ctx() ctx: RequestContext,
  ): Promise<object> {
    // -------------------------------------------------------------------------
    // Step 1: load the Vendure Payment (with relations)
    // -------------------------------------------------------------------------
    let payment: Payment | undefined;
    try {
      payment = await this.paymentService.findOneOrThrow(ctx, paymentId as any, ['order']);
    } catch {
      // Payment not found
    }

    if (!payment) {
      return cancelPaymentError({
        errorCode: 'VIVA_PAYMENT_NOT_CANCELLABLE',
        message: 'Payment not found.',
      });
    }

    // -------------------------------------------------------------------------
    // Step 2: load the Order (full record with customer.user relation)
    // -------------------------------------------------------------------------
    const orderStub = (payment as any).order as Order | undefined;
    if (!orderStub) {
      return cancelPaymentError({
        errorCode: 'VIVA_PAYMENT_NOT_CANCELLABLE',
        message: 'Payment is not associated with an order.',
      });
    }

    const order = await this.orderService.findOne(ctx, orderStub.id, ['customer', 'customer.user']);
    if (!order) {
      return cancelPaymentError({
        errorCode: 'VIVA_PAYMENT_NOT_CANCELLABLE',
        message: 'Order not found.',
      });
    }

    // -------------------------------------------------------------------------
    // Step 3: Authorization — order owner check
    //
    // Case A — Authenticated customer: ctx.activeUserId matches order.customer.user.id
    // Case B — Anonymous order: order matches the session's active order
    //          (Vendure stores activeOrderId / activeOrder.code on session)
    // -------------------------------------------------------------------------
    const isAuthorized = await this._isOrderOwner(ctx, order);
    if (!isAuthorized) {
      return cancelPaymentError({
        errorCode: 'AUTHORIZATION_FAILED',
        message: 'You may only cancel your own payments.',
      });
    }

    // -------------------------------------------------------------------------
    // Step 4: load viva_transaction row
    // -------------------------------------------------------------------------
    const vivaRow = await this.stateMachine.getVivaTransaction(ctx, ctx.channelId, paymentId);

    // -------------------------------------------------------------------------
    // Step 5: row missing or no vivaOrderCode
    // -------------------------------------------------------------------------
    if (!vivaRow || !vivaRow.vivaOrderCode) {
      return cancelPaymentError({
        errorCode: 'VIVA_PAYMENT_NOT_CANCELLABLE',
        message: 'No Viva order code found — payment may not have been initiated.',
      });
    }

    // -------------------------------------------------------------------------
    // Step 6: already-terminal status guard (row-level, no Viva call needed)
    // -------------------------------------------------------------------------
    if (TERMINAL_STATUSES.has(vivaRow.status)) {
      return cancelPaymentError({
        errorCode: 'VIVA_PAYMENT_NOT_CANCELLABLE',
        message: `Payment is already in terminal state: ${vivaRow.status}.`,
      });
    }

    // -------------------------------------------------------------------------
    // Step 7: cancel the Vendure Payment via the payment state machine.
    //
    // PaymentService.cancelPayment invokes our handler's cancelPayment (which
    // voids the Viva order + sets viva_transaction.status='cancelled') AND
    // transitions the Vendure Payment Created→Cancelled. The transition is the
    // critical half: Vendure's totalCoveredByPayments() counts every payment
    // except Error/Declined/Cancelled, so a lingering Created payment makes the
    // order's outstanding amount 0 — the customer cannot retry, and the ISV
    // guard then throws "isvAmount must be strictly less than order amount (0)".
    // Calling the handler fn directly (the previous behaviour) voided Viva but
    // never moved the Payment off Created. See issue #12.
    //
    // Our handler throws VivaPluginError on a Viva-side failure; core does NOT
    // catch it, so it propagates here, the Payment is left untouched, and we map
    // the error below exactly as before.
    // -------------------------------------------------------------------------
    try {
      const cancelResult = await this.paymentService.cancelPayment(ctx, payment.id);
      if (isGraphQlErrorResult(cancelResult)) {
        // The Payment FSM rejected Created→Cancelled (should not happen with the
        // default process). Surface rather than silently proceeding.
        Logger.error(
          `[cancelPayment] PaymentService.cancelPayment failed for paymentId=${paymentId}: ` +
            `${(cancelResult as { message?: string }).message ?? 'unknown transition error'}`,
          VIVA_LOG_CONTEXT,
        );
        return cancelPaymentError({
          errorCode: 'VIVA_INTERNAL_ERROR',
          message: 'Failed to cancel the payment.',
        });
      }
    } catch (err) {
      if (err instanceof VivaPluginError) {
        return cancelPaymentError({
          errorCode: err.code,
          message: err.message,
          ...(err.vivaErrorCode !== undefined ? { vivaErrorCode: err.vivaErrorCode } : {}),
          ...(err.vivaErrorMessage !== undefined ? { vivaErrorMessage: err.vivaErrorMessage } : {}),
        });
      }
      // Unexpected error — surface as internal
      const msg = err instanceof Error ? err.message : String(err);
      Logger.error(`[cancelPayment] Unexpected error for paymentId=${paymentId}: ${msg}`, VIVA_LOG_CONTEXT);
      return cancelPaymentError({
        errorCode: 'VIVA_INTERNAL_ERROR',
        message: 'An unexpected error occurred while cancelling the payment.',
      });
    }

    // -------------------------------------------------------------------------
    // Step 8: transition Order back to AddingItems
    // -------------------------------------------------------------------------
    const refreshedOrder = await this.orderService.findOne(ctx, order.id);
    if (refreshedOrder && refreshedOrder.state !== 'AddingItems') {
      try {
        await this.orderService.transitionToState(ctx, order.id, 'AddingItems' as any);
      } catch (err) {
        // Race with webhook sweep — if already AddingItems treat as idempotent success
        const msg = err instanceof Error ? err.message : String(err);
        Logger.warn(
          `[cancelPayment] transitionToState('AddingItems') failed for order ${String(order.id)}: ${msg}. ` +
          `Treating as idempotent (order may already be AddingItems).`,
          VIVA_LOG_CONTEXT,
        );
        // Re-check current state
        const recheckOrder = await this.orderService.findOne(ctx, order.id);
        if (recheckOrder && recheckOrder.state !== 'AddingItems') {
          return cancelPaymentError({
            errorCode: 'VIVA_INTERNAL_ERROR',
            message: `Failed to transition order to AddingItems: ${msg}`,
          });
        }
      }
    }

    // -------------------------------------------------------------------------
    // Step 9: return the updated Order
    // -------------------------------------------------------------------------
    const finalOrder = await this.orderService.findOne(ctx, order.id);
    return { ...(finalOrder ?? order), __typename: 'Order' };
  }

  // ---------------------------------------------------------------------------
  // Private: authorization helper
  //
  // Vendure anonymous-order pattern:
  //   OrderService.getActiveOrderForUser(ctx) returns the session's current
  //   active order (keyed by session token, not customer). We compare by id.
  //   For authenticated users, ctx.activeUserId is available.
  // ---------------------------------------------------------------------------

  private async _isOrderOwner(ctx: RequestContext, order: Order): Promise<boolean> {
    // Case A: authenticated customer
    if (ctx.activeUserId) {
      const orderCustomerUserId = (order as any).customer?.user?.id;
      if (orderCustomerUserId !== undefined && orderCustomerUserId !== null) {
        return String(ctx.activeUserId) === String(orderCustomerUserId);
      }
      // Customer exists but user relation missing — fall through to active-order check
    }

    // Case B: anonymous order — compare with session's active order
    try {
      const activeOrder = await this.orderService.getActiveOrderForUser(ctx, ctx.session?.user?.id as any);
      if (activeOrder && String(activeOrder.id) === String(order.id)) {
        return true;
      }
    } catch {
      // getActiveOrderForUser may throw if no session — treat as unauthorized
    }

    // Case B fallback: check activeOrderId on session (Vendure stores this on CachedSession)
    const sessionActiveOrderId = (ctx as any).session?.activeOrderId;
    if (sessionActiveOrderId !== undefined && sessionActiveOrderId !== null) {
      return String(sessionActiveOrderId) === String(order.id);
    }

    return false;
  }
}
