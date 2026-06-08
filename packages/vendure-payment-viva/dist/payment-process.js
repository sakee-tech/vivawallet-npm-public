"use strict";
/**
 * payment-process.ts — custom Vendure PaymentProcess for the Viva redirect flow.
 *
 * WHY THIS EXISTS (public #10):
 *   `vivaPaymentMethodHandler.createPayment` returns `state: 'Created'` — its
 *   documented contract (D3): mint the Viva order + Smart Checkout redirect URL
 *   synchronously, return the customer to the hosted page, and let the async
 *   1796 webhook drive the later Created → Settled transition.
 *
 *   But Vendure's `PaymentService.createPayment` ALWAYS persists the new Payment
 *   in the initial `'Created'` state and then immediately calls
 *   `transition(payment, result.state)`. When the handler returns `'Created'`,
 *   that is a `Created → Created` SELF-transition. The default payment process
 *   only allows `Created → ['Authorized','Settled','Declined','Error','Cancelled']`,
 *   so the FSM rejects it:
 *
 *     Cannot transition Payment from "Created" to "Created"
 *
 *   → addPaymentToOrder throws → 500 → storefront bounces to /?paymentInProgress=1
 *   and no Viva order is ever surfaced. This custom process adds `Created` to the
 *   allowed targets of `Created`, legalising the self-transition.
 *
 * WHY NOT MATCH STRIPE/MOLLIE INSTEAD:
 *   The official redirect plugins sidestep the problem by NEVER returning
 *   `'Created'` — they mint the redirect/intent in a SEPARATE mutation and only
 *   call addPaymentToOrder (returning `Settled`) from the webhook AFTER the
 *   payment is confirmed. Viva's architecture is redirect-first by design (the
 *   order code IS the redirect ref, minted in createPayment), so the minimal,
 *   in-contract fix is to permit the self-transition rather than re-architect.
 *
 * SAFETY:
 *   The merge is additive (concat, not replace) — every default transition out
 *   of `Created` is preserved. `Created → Created` only fires the lifecycle
 *   hooks; the default process's onTransitionEnd writes a history entry and
 *   checks `orderTotalIsCovered(order,'Settled')`, which is false while the
 *   payment is still `Created`, so NO spurious order transition occurs.
 *
 * @see docs/plans/vendure-plugin-v0.md §"Architecture Decisions D3"
 * @see node_modules/@vendure/core …/config/payment/default-payment-process.js
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.vivaPaymentProcess = void 0;
const core_1 = require("@vendure/core");
const state_machine_service_js_1 = require("./services/state-machine.service.js");
const constants_js_1 = require("./constants.js");
let stateMachine;
/**
 * Custom payment process for the Viva redirect flow. Two responsibilities:
 *
 * 1. `transitions` — permits the `Created → Created` self-transition that
 *    `createPayment`'s `state: 'Created'` return forces (public #10).
 *
 * 2. `onTransitionStart` — reconciles the `viva_transaction.paymentId` proxy
 *    (#13). `createPayment` writes the row keyed on `order.id` because Vendure
 *    assigns the real `Payment.id` only AFTER the handler returns, so it has no
 *    way to store it. This hook runs during the create-time transition, where
 *    the real `Payment.id` IS available, and reconciles the row (located by the
 *    unique `vivaOrderCode` it stamped into the payment metadata). Without it,
 *    every later lookup by `Payment.id` — cancelPayment, the webhook settle
 *    path, settlePayment, createRefund — misses, and only worked when
 *    `order.id === payment.id` (true in test DBs, false in production).
 *
 * Registered via `config.paymentOptions.customPaymentProcess` in the plugin's
 * `configuration()`.
 */
exports.vivaPaymentProcess = {
    transitions: {
        Created: {
            to: ['Created'],
            // Additive: keep the default Created → Authorized/Settled/… targets.
            mergeStrategy: 'merge',
        },
    },
    init(injector) {
        stateMachine = injector.get(state_machine_service_js_1.StateMachineService);
    },
    async onTransitionStart(_fromState, toState, data) {
        // Only at creation, and only for payments WE created — identified by the
        // vivaOrderCode we stamped into the metadata (the PaymentMethod code is
        // operator-chosen and unreliable).
        if (toState !== 'Created' || !stateMachine)
            return;
        const vivaOrderCode = data.payment?.metadata?.['vivaOrderCode'];
        if (!vivaOrderCode)
            return;
        // NEVER block the payment: reconciliation failure is logged and swallowed
        // (returning undefined = transition allowed). Runs inside the createPayment
        // transaction, so it sees the row inserted earlier in the same unit of work.
        try {
            await stateMachine.reconcilePaymentId(data.ctx, vivaOrderCode, data.payment.id);
        }
        catch (err) {
            core_1.Logger.error(`[vivaPaymentProcess] Failed to reconcile viva_transaction.paymentId for ` +
                `vivaOrderCode=${vivaOrderCode}: ${err instanceof Error ? err.message : String(err)}`, constants_js_1.VIVA_LOG_CONTEXT);
        }
    },
};
//# sourceMappingURL=payment-process.js.map