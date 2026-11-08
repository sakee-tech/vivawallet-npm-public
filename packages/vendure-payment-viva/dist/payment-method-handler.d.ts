/**
 * payment-method-handler.ts — Vendure PaymentMethodHandler for Viva Wallet ISV.
 *
 * Handler code: 'viva'
 * Storefront calls: addPaymentToOrder({ method: 'viva' })
 * Plan state contract: createPayment returns 'Created' (D3, §2)
 *
 * @see docs/plans/vendure-plugin-v0.md §"API Surface — PaymentMethodHandler operations"
 * @see docs/plans/vendure-plugin-v0.md §"Architecture Decisions D3 + D5 + D11"
 */
import { PaymentMethodHandler } from '@vendure/core';
import type { ID, Refund, RequestContext } from '@vendure/core';
import { Payments } from '@sakeetech/viva-payments-core/payments';
import { BasicAuthClient } from '@sakeetech/viva-payments-core/legacy';
import { FastRefundClient } from '@sakeetech/viva-payments-core/refunds';
import type { VivaPaymentPluginOptions } from './types.js';
import type { VivaOAuth2Strategy } from './providers/viva-oauth2-strategy.provider.js';
import { StateMachineService } from './services/state-machine.service.js';
/** @internal Test-only: inject dependencies without NestJS DI. */
export declare function _testInjectDeps(opts: {
    options: VivaPaymentPluginOptions;
    oauth2: VivaOAuth2Strategy;
    stateMachine: StateMachineService;
    isvPayments?: Payments;
    fastRefundClient?: FastRefundClient;
    /** Test-only: MockAgent-backed reseller client for the ISV refund path. */
    resellerLegacyClient?: BasicAuthClient;
}): void;
export declare const vivaPaymentMethodHandler: PaymentMethodHandler<{}>;
/** #5: a Pending refund's full key; its (GraphQL-visible) metadata keeps only the part after the payment id. */
export declare function pendingRefundKey(refund: {
    paymentId: ID;
    metadata: unknown;
}): string | undefined;
/**
 * #5: resolve a Pending Viva Refund from Viva's own (authenticated) refund
 * listing, by the key it was tagged with (`merchantTrns`). Shared by the Admin
 * `checkVivaRefund` mutation and webhook 1797 (whose envelope is only a lookup
 * hint; this listing is the proof).
 *   - not Pending                → returned as is (replay / already resolved).
 *   - one listed, amount matches → row bookkeeping (trap 3), then Settled.
 *   - none listed                → 'absent', still Pending; the caller decides:
 *                                  the check fails it (failVivaRefund: Viva has no
 *                                  refund with this key, so a fresh refund is
 *                                  safe), 1797 retries.
 *   - listing fails, or a listed refund doesn't match → throws; stays Pending,
 *                                  never Failed on a guess.
 * No identifiers in thrown messages or logs (host rule).
 */
export declare function checkVivaRefund(ctx: RequestContext, refundId: ID): Promise<{
    outcome: 'settled' | 'failed' | 'absent';
    refund: Refund;
}>;
/** #5 check: Viva has no refund with this Pending refund's key → Failed (a fresh refund is then safe). */
export declare function failVivaRefund(ctx: RequestContext, refund: Refund): Promise<Refund>;
/**
 * #31: record a refund Viva made outside Vendure (a 1797 matching no Pending
 * refund). The envelope only names the refund: its amount and time come from
 * Viva's AUTHENTICATED refund listing for this payment. No Viva call that moves
 * money and no Vendure Refund (`refundOrder` would run createRefund and pay
 * again): an entry on the row, which createRefund's cap and the
 * row status count. Run inside a transaction: the row is locked while recording.
 *   - already recorded, or a Settled Vendure refund → 'known' (replay; no Viva call)
 *   - listed with this plugin's key and a non-Failed Vendure refund with that key,
 *     or the row's `started` note for it → 'known': ours, in flight or left to the
 *     #2 reconcile, so counting it would count it twice. Our key with neither (an
 *     orphan, e.g. its note was overwritten) is recorded like any outside refund.
 *   - not listed → 'absent' (the listing may lag; 1797 retries)
 *   - listing fails → throws, nothing recorded
 * No identifiers in thrown messages or logs (host rule).
 */
export declare function recordExternalRefund(ctx: RequestContext, payment: {
    id: ID;
    amount: number;
}, transactionId: string): Promise<{
    outcome: 'recorded';
    amount: number;
} | {
    outcome: 'known' | 'absent';
}>;
//# sourceMappingURL=payment-method-handler.d.ts.map