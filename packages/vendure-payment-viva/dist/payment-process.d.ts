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
import type { PaymentProcess } from '@vendure/core';
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
export declare const vivaPaymentProcess: PaymentProcess<never>;
//# sourceMappingURL=payment-process.d.ts.map