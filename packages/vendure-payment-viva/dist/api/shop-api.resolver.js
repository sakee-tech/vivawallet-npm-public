"use strict";
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
Object.defineProperty(exports, "__esModule", { value: true });
exports.VivaShopApiResolver = void 0;
const graphql_1 = require("@nestjs/graphql");
const common_1 = require("@nestjs/common");
const core_1 = require("@vendure/core");
const state_machine_service_js_1 = require("../services/state-machine.service.js");
const error_envelope_js_1 = require("../util/error-envelope.js");
const constants_js_1 = require("../constants.js");
// ---------------------------------------------------------------------------
// Terminal statuses that cannot be cancelled
// ---------------------------------------------------------------------------
const TERMINAL_STATUSES = new Set(['captured', 'refunded', 'partially_refunded', 'failed', 'cancelled']);
// ---------------------------------------------------------------------------
// GraphQL union return types (plain objects with __typename for Vendure)
// ---------------------------------------------------------------------------
function cancelPaymentError(opts) {
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
let VivaShopApiResolver = class VivaShopApiResolver {
    orderService;
    paymentService;
    connection;
    stateMachine;
    options;
    constructor(orderService, paymentService, connection, stateMachine, options) {
        this.orderService = orderService;
        this.paymentService = paymentService;
        this.connection = connection;
        this.stateMachine = stateMachine;
        this.options = options;
    }
    async cancelPayment(paymentId, ctx) {
        // -------------------------------------------------------------------------
        // Step 1: load the Vendure Payment (with relations)
        // -------------------------------------------------------------------------
        let payment;
        try {
            payment = await this.paymentService.findOneOrThrow(ctx, paymentId, ['order']);
        }
        catch {
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
        const orderStub = payment.order;
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
            if ((0, core_1.isGraphQlErrorResult)(cancelResult)) {
                // The Payment FSM rejected Created→Cancelled (should not happen with the
                // default process). Surface rather than silently proceeding.
                core_1.Logger.error(`[cancelPayment] PaymentService.cancelPayment failed for paymentId=${paymentId}: ` +
                    `${cancelResult.message ?? 'unknown transition error'}`, constants_js_1.VIVA_LOG_CONTEXT);
                return cancelPaymentError({
                    errorCode: 'VIVA_INTERNAL_ERROR',
                    message: 'Failed to cancel the payment.',
                });
            }
        }
        catch (err) {
            if (err instanceof error_envelope_js_1.VivaPluginError) {
                return cancelPaymentError({
                    errorCode: err.code,
                    message: err.message,
                    ...(err.vivaErrorCode !== undefined ? { vivaErrorCode: err.vivaErrorCode } : {}),
                    ...(err.vivaErrorMessage !== undefined ? { vivaErrorMessage: err.vivaErrorMessage } : {}),
                });
            }
            // Unexpected error — surface as internal
            const msg = err instanceof Error ? err.message : String(err);
            core_1.Logger.error(`[cancelPayment] Unexpected error for paymentId=${paymentId}: ${msg}`, constants_js_1.VIVA_LOG_CONTEXT);
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
                await this.orderService.transitionToState(ctx, order.id, 'AddingItems');
            }
            catch (err) {
                // Race with webhook sweep — if already AddingItems treat as idempotent success
                const msg = err instanceof Error ? err.message : String(err);
                core_1.Logger.warn(`[cancelPayment] transitionToState('AddingItems') failed for order ${String(order.id)}: ${msg}. ` +
                    `Treating as idempotent (order may already be AddingItems).`, constants_js_1.VIVA_LOG_CONTEXT);
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
    async _isOrderOwner(ctx, order) {
        // Case A: authenticated customer
        if (ctx.activeUserId) {
            const orderCustomerUserId = order.customer?.user?.id;
            if (orderCustomerUserId !== undefined && orderCustomerUserId !== null) {
                return String(ctx.activeUserId) === String(orderCustomerUserId);
            }
            // Customer exists but user relation missing — fall through to active-order check
        }
        // Case B: anonymous order — compare with session's active order
        try {
            const activeOrder = await this.orderService.getActiveOrderForUser(ctx, ctx.session?.user?.id);
            if (activeOrder && String(activeOrder.id) === String(order.id)) {
                return true;
            }
        }
        catch {
            // getActiveOrderForUser may throw if no session — treat as unauthorized
        }
        // Case B fallback: check activeOrderId on session (Vendure stores this on CachedSession)
        const sessionActiveOrderId = ctx.session?.activeOrderId;
        if (sessionActiveOrderId !== undefined && sessionActiveOrderId !== null) {
            return String(sessionActiveOrderId) === String(order.id);
        }
        return false;
    }
};
exports.VivaShopApiResolver = VivaShopApiResolver;
__decorate([
    (0, graphql_1.Mutation)(),
    __param(0, (0, graphql_1.Args)('paymentId')),
    __param(1, (0, core_1.Ctx)()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String, core_1.RequestContext]),
    __metadata("design:returntype", Promise)
], VivaShopApiResolver.prototype, "cancelPayment", null);
exports.VivaShopApiResolver = VivaShopApiResolver = __decorate([
    (0, graphql_1.Resolver)(),
    __param(4, (0, common_1.Inject)(constants_js_1.VIVA_PLUGIN_OPTIONS)),
    __metadata("design:paramtypes", [core_1.OrderService,
        core_1.PaymentService,
        core_1.TransactionalConnection,
        state_machine_service_js_1.StateMachineService, Object])
], VivaShopApiResolver);
//# sourceMappingURL=shop-api.resolver.js.map