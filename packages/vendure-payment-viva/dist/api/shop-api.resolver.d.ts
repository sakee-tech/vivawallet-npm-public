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
import { RequestContext, OrderService, PaymentService, TransactionalConnection } from '@vendure/core';
import { StateMachineService } from '../services/state-machine.service.js';
import type { VivaPaymentPluginOptions } from '../types.js';
export declare class VivaShopApiResolver {
    private readonly orderService;
    private readonly paymentService;
    private readonly connection;
    private readonly stateMachine;
    private readonly options;
    constructor(orderService: OrderService, paymentService: PaymentService, connection: TransactionalConnection, stateMachine: StateMachineService, options: VivaPaymentPluginOptions);
    cancelPayment(paymentId: string, ctx: RequestContext): Promise<object>;
    private _isOrderOwner;
}
//# sourceMappingURL=shop-api.resolver.d.ts.map