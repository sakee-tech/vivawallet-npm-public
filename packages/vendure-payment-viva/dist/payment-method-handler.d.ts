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
import { Payments } from '@sakeetech/viva-payments-core/payments';
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
}): void;
export declare const vivaPaymentMethodHandler: PaymentMethodHandler<{}>;
//# sourceMappingURL=payment-method-handler.d.ts.map