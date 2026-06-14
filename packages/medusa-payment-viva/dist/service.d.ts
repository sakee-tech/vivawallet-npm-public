/**
 * service.ts — VivaPaymentProvider (Medusa v2 AbstractPaymentProvider)
 *
 * Implements all required Medusa v2 payment provider methods, bridging the
 * Medusa payment lifecycle to the Viva Wallet ISV Smart Checkout flow.
 *
 * Key design choices:
 * - A4 (write-pending-first): INSERT into viva_transaction with status='initiated'
 *   and viva_order_code=NULL BEFORE calling Viva's createOrder API.
 * - P14 (idempotency): deduplicate by idempotency_key = medusa_payment_id.
 * - P18 (refund validation): validate amount <= captured - refunded before Viva API.
 * - P19 (single-tenant invariant): assertSingleTenantCart before any DB write.
 * - Error model (plan lines 339–344): wrap all Viva errors into MedusaError types.
 *
 * AbstractPaymentProvider required methods (read from @medusajs/utils dist):
 *   capturePayment, authorizePayment, cancelPayment, initiatePayment,
 *   deletePayment, getPaymentStatus, refundPayment, retrievePayment,
 *   updatePayment, getWebhookActionAndData
 *
 * Smart Checkout redirect URL:
 * - Demo:       https://demo.vivapayments.com/web/checkout?ref={OrderCode}
 * - Production: https://www.vivapayments.com/web/checkout?ref={OrderCode}
 *
 * @see references/viva-docs/md/payment-isv-api.txt:1 (ISV API overview)
 * @see references/viva-docs/md/smart-checkout-save-payment.txt:1 (redirect URL)
 * @see references/viva-docs/md/tut-create-recurring-payment.txt:1 (checkout URL format)
 * @see references/viva-docs/md/isv-partner-program.txt:61 (P14, P15, P18, P19, A4)
 * @see references/viva-docs/md/isv-credentials.txt:107 (auth credential types)
 * @see references/viva-docs/md/oauth2-authentication.txt:128 (token endpoint)
 */
import { AbstractPaymentProvider } from '@medusajs/framework/utils';
import type { InitiatePaymentInput, InitiatePaymentOutput, AuthorizePaymentInput, AuthorizePaymentOutput, CapturePaymentInput, CapturePaymentOutput, RefundPaymentInput, RefundPaymentOutput, CancelPaymentInput, CancelPaymentOutput, RetrievePaymentInput, RetrievePaymentOutput, GetPaymentStatusInput, GetPaymentStatusOutput, DeletePaymentInput, DeletePaymentOutput, UpdatePaymentInput, UpdatePaymentOutput, ProviderWebhookPayload, WebhookActionResult } from '@medusajs/framework/types';
import type { EntityManager } from '@medusajs/framework/mikro-orm/core';
import { Payments } from '@sakeetech/viva-payments-core/payments';
import { BasicAuthClient } from '@sakeetech/viva-payments-core/legacy';
import { FastRefundClient } from '@sakeetech/viva-payments-core/refunds';
import type { MinorUnits, TransactionId } from '@sakeetech/viva-payments-core/types';
import type { VivaPluginConfig } from './config.js';
import type { TenantResolver } from './resolvers/tenant-resolver.js';
export interface VivaPaymentProviderOptions {
    config: VivaPluginConfig;
    /**
     * Injected tenant resolver. Defaults to DefaultTenantResolver which reads
     * `cart.metadata.tenant_id`.
     *
     * @see references/viva-docs/md/isv-partner-program.txt:61 (P5)
     */
    tenantResolver?: TenantResolver;
}
/**
 * Medusa v2 payment provider for Viva Wallet Smart Checkout (ISV multi-tenant).
 *
 * Identifier: 'viva'. Payment provider ID format: pp_viva_<id>.
 * The <id> comes from the `id` field in medusa-config.ts providers array.
 *
 * @see references/viva-docs/md/payment-isv-api.txt:1 (ISV payment creation)
 * @see references/viva-docs/md/smart-checkout-save-payment.txt:1 (redirect URL)
 * @see references/viva-docs/md/isv-partner-program.txt:61 (ISV overview)
 */
export declare class VivaPaymentProvider extends AbstractPaymentProvider<VivaPaymentProviderOptions> {
    static readonly identifier = "viva";
    protected readonly vivaConfig: VivaPluginConfig;
    protected readonly isvPayments: Payments;
    protected readonly legacyClient: BasicAuthClient | undefined;
    protected readonly fastRefundClient: FastRefundClient;
    protected readonly tenantResolver: TenantResolver;
    protected readonly em: EntityManager;
    constructor(container: Record<string, unknown>, options: VivaPaymentProviderOptions);
    /**
     * Initiates a payment session (Medusa calls this when customer selects Viva):
     * 1. P19: assert single-tenant cart (from input.context)
     * 2. Resolve tenant → Viva merchant
     * 3. P14 dedup: check for existing transaction by idempotency_key
     * 4. A4 write-pending-first: INSERT transaction row BEFORE Viva API call
     * 5. Call Viva createOrder
     * 6. Update row with viva_order_code
     * 7. Return redirect URL in data (storefront uses this to redirect customer)
     *
     * The medusa_payment_id is derived from input.context.idempotency_key (set by
     * Medusa Payment Module) or generated per call.
     *
     * @see references/viva-docs/md/payment-isv-api.txt:1 (createOrder)
     * @see references/viva-docs/md/smart-checkout-save-payment.txt:1 (redirect URL)
     * @see references/viva-docs/md/isv-partner-program.txt:61 (P14, P19, A4)
     */
    initiatePayment(input: InitiatePaymentInput): Promise<InitiatePaymentOutput>;
    /**
     * Consults the DB for the latest transaction status.
     * For Smart Checkout, authorization is off-band (redirect + webhook).
     * Called during cart-completion; returns current DB status.
     *
     * @see references/viva-docs/md/payment-isv-api.txt:1 (Smart Checkout flow)
     * @see references/viva-docs/md/isv-partner-program.txt:61 (P6 Smart Checkout)
     */
    authorizePayment(input: AuthorizePaymentInput): Promise<AuthorizePaymentOutput>;
    /**
     * Capture is implicit on Smart Checkout completion (1796 webhook).
     * This method is idempotent: if already captured, returns success.
     * If not yet captured, logs a warning and returns current state.
     *
     * NOTE: Do NOT call Viva's capture endpoint. Capture is automatic on
     * Smart Checkout completion per Viva's ISV model.
     *
     * @see references/viva-docs/md/payment-isv-api.txt:1 (implicit capture)
     * @see references/viva-docs/md/isv-partner-program.txt:61 (P6 Smart Checkout)
     */
    capturePayment(input: CapturePaymentInput): Promise<CapturePaymentOutput>;
    /**
     * Issues a full or partial refund via Viva ISV API.
     *
     * P18 validation: refundAmountMinor <= capturedAmount - alreadyRefunded.
     * Auth: primary OAuth2 strategy (Q5 — if Viva rejects with 401/403, reseller
     * auth may be required; log warning and re-raise for now).
     * Partial refund: increments refunded_amount_minor; status stays 'captured'.
     * Full refund: transitions status to 'refunded' via lattice.
     *
     * @see references/viva-docs/md/isv-partner-program.txt:296 (P18 refund, ISV fee reversal)
     * @see references/viva-docs/md/payment-isv-api.txt:1 (refund endpoint)
     */
    refundPayment(input: RefundPaymentInput): Promise<RefundPaymentOutput>;
    /**
     * Merchant-mode refund routing — Fast vs Standard with auto-fallback.
     *
     * Flow:
     *   1. retrieveTransaction → cardType (for refund-strategy decision).
     *   2. resolveRefundStrategy(config.refundStrategy ?? 'auto', { cardType, CNP: true }).
     *   3. If decision.kind === 'fast': call FastRefundClient.refund.
     *      - 403 + strategy === 'fast' → throw VivaApiError with vivaCode
     *        'VIVA_FAST_REFUND_INELIGIBLE'.
     *      - 403 + strategy === 'auto' → fall through to Standard refund.
     *      - any other error → re-throw.
     *   4. Otherwise call BasicAuthClient via Payments.refundPayment (Standard).
     *
     * Smart Checkout is always card-not-present (CNP), so `isCardNotPresent: true`.
     *
     * @see docs/ENDPOINTS.md §4
     * @see docs/plans/multi-mode-v0.md §9
     * @see references/payment-api.yaml:9255 (Fast Refund 403 semantics)
     */
    protected refundPaymentMerchantMode(params: {
        vivaTransactionId: TransactionId;
        refundAmountMinor: MinorUnits;
        refundIdempotencyKey: string;
        medusaRefundId: string;
    }): Promise<void>;
    /**
     * Cancels a Viva order (valid for unpaid orders not yet captured).
     * Idempotent: skip API call if already in terminal cancelled state.
     * Apply lattice: authorized → cancelled (A9 path).
     *
     * @see references/viva-docs/md/payment-isv-api.txt:1 (cancelOrder)
     * @see references/viva-docs/md/isv-partner-program.txt:61 (P18, A9)
     */
    cancelPayment(input: CancelPaymentInput): Promise<CancelPaymentOutput>;
    /**
     * Returns the serialized viva_transaction row for the given payment.
     *
     * @see references/viva-docs/md/isv-partner-program.txt:104
     */
    retrievePayment(input: RetrievePaymentInput): Promise<RetrievePaymentOutput>;
    /**
     * Returns the current Medusa-mapped payment status from the DB.
     *
     * @see references/viva-docs/md/isv-partner-program.txt:104
     */
    getPaymentStatus(input: GetPaymentStatusInput): Promise<GetPaymentStatusOutput>;
    /**
     * Logical-only deletion — does NOT delete the Viva transaction (audit trail).
     * The viva_transaction row is preserved for forensics and idempotency replay.
     *
     * @see references/viva-docs/md/isv-partner-program.txt:104
     */
    deletePayment(input: DeletePaymentInput): Promise<DeletePaymentOutput>;
    /**
     * No-op for Smart Checkout: Viva orders cannot be updated after creation.
     * If amount changes, caller should cancel and re-initiate.
     *
     * @see references/viva-docs/md/payment-isv-api.txt:1 (order immutability)
     */
    updatePayment(input: UpdatePaymentInput): Promise<UpdatePaymentOutput>;
    /**
     * Processes Viva webhook events received via the /viva/webhook route (S8).
     * S8 routes the verified webhook payload here.
     *
     * Viva webhook event types in v1 scope:
     *   1796 - Transaction Payment Created → action: 'captured'
     *   1797 - Transaction Reversal Created → action: 'authorized' (refund)
     *   1798 - Transaction Failed → action: 'failed'
     *   4865 - Order Updated (cancellation) → action: 'canceled'
     *
     * NOTE: This is the minimal implementation for S6. The full webhook processing
     * subscriber (status lattice updates, Retrieve Transaction API call per plan
     * step 4.a) is implemented in S8.
     *
     * @see references/viva-docs/md/isv-partner-program.txt:104 (webhook flow)
     * @see references/viva-docs/md/webhooks-for-payments.txt:248 (retrieve before update)
     */
    getWebhookActionAndData(data: ProviderWebhookPayload['payload']): Promise<WebhookActionResult>;
}
//# sourceMappingURL=service.d.ts.map