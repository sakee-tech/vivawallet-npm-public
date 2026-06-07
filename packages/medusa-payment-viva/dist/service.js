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
import { AbstractPaymentProvider, MedusaError } from '@medusajs/framework/utils';
import { v4 as uuidv4 } from 'uuid';
import { IsvHttpClient } from '@sakeetech/viva-payments-core/isv';
import { Payments } from '@sakeetech/viva-payments-core/payments';
import { BasicAuthClient } from '@sakeetech/viva-payments-core/legacy';
import { FastRefundClient, resolveRefundStrategy, } from '@sakeetech/viva-payments-core/refunds';
import { VivaAuthError, VivaApiError, VivaValidationError, VivaRateLimitError, VivaModeMismatchError, } from '@sakeetech/viva-payments-core/errors';
import { validateStatusTransition, } from '@sakeetech/viva-payments-core/webhooks';
import { assertSingleTenantCart, DefaultTenantResolver, } from './resolvers/tenant-resolver.js';
import { buildAuthStrategies } from './resolvers/auth-strategy-factory.js';
// ---------------------------------------------------------------------------
// Smart Checkout redirect URL builder
// ---------------------------------------------------------------------------
/**
 * Builds the Smart Checkout redirect URL for a given order code.
 *
 * Pattern confirmed from Viva docs:
 *   Demo:       https://demo.vivapayments.com/web/checkout?ref={OrderCode}
 *   Production: https://www.vivapayments.com/web/checkout?ref={OrderCode}
 *
 * @see references/viva-docs/md/tut-create-recurring-payment.txt:1 (URL format)
 * @see references/viva-docs/md/smart-checkout-save-payment.txt:1 (Smart Checkout)
 */
function buildCheckoutUrl(environment, orderCode) {
    const baseUrl = environment === 'demo'
        ? 'https://demo.vivapayments.com'
        : 'https://www.vivapayments.com';
    // @see references/viva-docs/md/tut-create-recurring-payment.txt:1
    return `${baseUrl}/web/checkout?ref=${orderCode.toString()}`;
}
// ---------------------------------------------------------------------------
// ISO 4217 numeric currency code lookup
// ---------------------------------------------------------------------------
/**
 * Maps ISO 3-char alphabetic currency codes to ISO 4217 numeric codes.
 * Viva expects numeric codes in the createOrder request body.
 *
 * TODO(impl): extend this map for all currencies Viva supports.
 * Currently covers the primary markets listed in Viva docs.
 *
 * @see references/viva-docs/md/isv-partner-program.txt:83 (P15 currency encoding)
 */
const CURRENCY_ALPHA_TO_NUMERIC = {
    eur: '978',
    gbp: '826',
    usd: '840',
    pln: '985',
    ron: '946',
    czk: '203',
    huf: '348',
    bgn: '975',
    dkk: '208',
    sek: '752',
    nok: '578',
};
function toCurrencyCode(isoAlpha) {
    const numeric = CURRENCY_ALPHA_TO_NUMERIC[isoAlpha.toLowerCase()];
    if (!numeric) {
        // TODO(impl): add full ISO 4217 numeric lookup or accept numeric codes directly
        // Default to EUR (978) if unknown — operator should configure the currency correctly.
        console.warn(`[viva] Unknown currency code '${isoAlpha}', defaulting to EUR (978). ` +
            `Add the mapping in CURRENCY_ALPHA_TO_NUMERIC if needed.`);
        return '978';
    }
    return numeric;
}
// ---------------------------------------------------------------------------
// Medusa status mapping (plan P17)
// ---------------------------------------------------------------------------
/**
 * Maps internal VivaTransactionStatus to Medusa PaymentSessionStatus.
 *
 * Medusa status values: 'authorized' | 'captured' | 'pending' | 'requires_more'
 *                       | 'error' | 'canceled'
 *
 * @see references/viva-docs/md/isv-partner-program.txt:61 (P17 status lattice)
 */
function toMedusaStatus(vivaStatus) {
    switch (vivaStatus) {
        case 'authorized':
            return 'authorized';
        case 'captured':
            return 'authorized'; // Medusa treats captured as authorized from session perspective
        case 'initiated':
            return 'pending';
        case 'failed':
            return 'error';
        case 'cancelled':
            return 'canceled';
        case 'refunded':
            return 'authorized'; // session is complete; refunds tracked separately
        case 'disputed':
            return 'requires_more';
        default:
            return 'pending';
    }
}
// ---------------------------------------------------------------------------
// Error mapping (plan lines 339–344)
// ---------------------------------------------------------------------------
/**
 * Maps Viva error types to the appropriate MedusaError.
 *
 * Mapping (plan lines 339–344):
 *   VivaAuthError        → MedusaError.Types.UNAUTHORIZED
 *   VivaApiError         → MedusaError.Types.PAYMENT_AUTHORIZATION_ERROR
 *   VivaValidationError  → MedusaError.Types.INVALID_DATA
 *   VivaRateLimitError   → MedusaError.Types.PAYMENT_AUTHORIZATION_ERROR (retriable)
 *   VivaModeMismatchError → MedusaError.Types.NOT_ALLOWED
 *   MedusaError          → pass through unchanged
 *   Other                → MedusaError.Types.UNEXPECTED_STATE
 *
 * @see references/viva-docs/md/isv-partner-program.txt:104 (error model, plan 339)
 */
function toMedusaError(err) {
    if (err instanceof MedusaError) {
        return err;
    }
    if (err instanceof VivaModeMismatchError) {
        return new MedusaError(MedusaError.Types.NOT_ALLOWED, err.message);
    }
    if (err instanceof VivaAuthError) {
        return new MedusaError(MedusaError.Types.UNAUTHORIZED, err.message);
    }
    if (err instanceof VivaRateLimitError) {
        return new MedusaError(MedusaError.Types.PAYMENT_AUTHORIZATION_ERROR, err.message);
    }
    if (err instanceof VivaApiError) {
        return new MedusaError(MedusaError.Types.PAYMENT_AUTHORIZATION_ERROR, err.message);
    }
    if (err instanceof VivaValidationError) {
        return new MedusaError(MedusaError.Types.INVALID_DATA, err.message);
    }
    const message = err instanceof Error ? err.message : String(err);
    return new MedusaError(MedusaError.Types.UNEXPECTED_STATE, message);
}
// ---------------------------------------------------------------------------
// Mode-aware client construction (slice B)
// ---------------------------------------------------------------------------
/**
 * Default Smart Checkout source code for merchant mode when `config.sourceCode`
 * is unset. Viva accepts this on any merchant account out of the box.
 *
 * @see references/viva-docs/md/payment-source-for-isv.txt:101
 */
const DEFAULT_SOURCE_CODE = 'Default';
/**
 * Build the right {@link BasicAuthClient} (legacy host + Basic auth) per mode.
 *
 * Both modes use the merchant variant in slice B — the reseller variant is only
 * needed for IsvSources (`POST /api/sources`), which the payment provider does
 * not call. In ISV mode, the reseller-flavoured client is still built by
 * {@link buildAuthStrategies} for OAuth2 401-fallback.
 *
 * @see docs/AUTH.md §6.2
 */
function buildLegacyClient(config) {
    return new BasicAuthClient({
        authVariant: 'merchant',
        environment: config.environment,
        merchantId: config.legacyMerchantId,
        apiKey: config.legacyApiKey,
    });
}
/**
 * Build a mode-aware {@link Payments} instance.
 *
 * In merchant mode the constructed client emits URL paths without `/isv` and
 * without the `merchantId={uuid}` query parameter. The `Payments` class
 * silently ignores `opts.merchantId` when constructed with `mode='merchant'`.
 *
 * @see docs/plans/multi-mode-v0.md §9
 */
function buildPaymentsClient(config, httpClient, legacyClient) {
    return new Payments({
        mode: config.mode,
        client: httpClient,
        legacyClient,
    });
}
/**
 * Build a {@link FastRefundClient} bound to the OAuth2 acquiring scope.
 *
 * Caller is expected to fall back to standard refund on HTTP 403 when the
 * refund strategy is `'auto'`; when strategy is `'fast'` a 403 surfaces as
 * `VIVA_FAST_REFUND_INELIGIBLE`.
 *
 * @see docs/ENDPOINTS.md §4
 */
function buildFastRefundClient(httpClient) {
    return new FastRefundClient({ client: httpClient });
}
/**
 * Resolve the Viva merchantId to pass through to `Payments` calls per mode.
 *
 * In ISV mode this is the per-tenant merchant resolved from the cart. In
 * merchant mode there is no per-cart tenant — the `Payments` client ignores
 * `opts.merchantId` entirely so the value is irrelevant, but we still pass
 * the configured legacy merchant id for consistency in stored DB rows.
 */
function effectiveMerchantId(config, tenantMerchantId) {
    // In ISV mode the tenant resolver always returns a value before we get here.
    if (config.mode === 'isv' && tenantMerchantId)
        return tenantMerchantId;
    return config.legacyMerchantId;
}
// ---------------------------------------------------------------------------
// VivaPaymentProvider
// ---------------------------------------------------------------------------
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
export class VivaPaymentProvider extends AbstractPaymentProvider {
    static identifier = 'viva';
    vivaConfig;
    isvPayments;
    legacyClient;
    fastRefundClient;
    tenantResolver;
    em;
    constructor(container, options) {
        super(container, options);
        this.vivaConfig = options.config;
        // Build auth strategies from config
        const authStrategies = buildAuthStrategies(options.config);
        // Build ISV HTTP client with OAuth2 primary strategy
        const httpClient = new IsvHttpClient({
            environment: options.config.environment,
            authStrategy: authStrategies.primary,
        });
        // Build legacy Basic-auth client for refundPayment + Standard refund path.
        // Probe-verified 2026-04-25 (F1): POST /checkout/v2/transactions/{id} returns 405.
        // Refund must use legacy host with Basic auth (merchantId:apiKey).
        // @see references/viva-docs/md/tut-create-recurring-payment.txt:288
        this.legacyClient = buildLegacyClient(options.config);
        // Slice B: build the `Payments` client mode-aware. In merchant mode the
        // URL paths do NOT include the `/isv` segment and do NOT carry
        // `merchantId={uuid}` — see Payments.client.ts buildOrderCreateUrl etc.
        // @see docs/plans/multi-mode-v0.md §9
        this.isvPayments = buildPaymentsClient(options.config, httpClient, this.legacyClient);
        // Fast Refund client — used by the merchant-mode refundPayment flow when
        // strategy resolves to 'fast' (auto or explicit).
        // @see docs/ENDPOINTS.md §4
        this.fastRefundClient = buildFastRefundClient(httpClient);
        // EntityManager from container for DB access.
        // TODO(impl): verify the exact container key for Mikro-ORM EM in Medusa v2.
        // Standard pattern in Medusa v2: container['manager'] for the base EM.
        this.em = (container['manager'] ?? container['entityManager']);
        if (options.tenantResolver) {
            this.tenantResolver = options.tenantResolver;
        }
        else {
            this.tenantResolver = new DefaultTenantResolver(this.em);
        }
    }
    // --------------------------------------------------------------------------
    // initiatePayment
    // --------------------------------------------------------------------------
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
    async initiatePayment(input) {
        try {
            // Extract cart-like context for tenant resolution and P19 validation.
            // Medusa passes cart metadata via input.context. The actual cart is
            // not available here — only the customer context.
            // P19: validate that we have a single tenant (from context metadata if available)
            // TODO(impl): when Medusa passes cart items in context, pass them here.
            // For now assertSingleTenantCart is a no-op when items is empty.
            const contextMetadata = (input.data?.['cart_metadata'] ??
                input.data?.['metadata']);
            const cartLike = {
                id: input.data?.['cart_id'] ?? '',
                metadata: contextMetadata ?? null,
                items: input.data?.['items'] ?? [],
            };
            // P19: validate single-tenant cart before any DB write (ISV mode only —
            // merchant mode has no per-cart tenant concept).
            if (this.vivaConfig.mode === 'isv') {
                assertSingleTenantCart(cartLike);
            }
            // Resolve tenant → Viva merchant per mode:
            //   ISV mode: resolveTenant from cart → vivaMerchantId, sourceCode.
            //   Merchant mode: no per-cart tenant — vivaMerchantId is undefined and
            //   sourceCode falls back to config.sourceCode ?? 'Default'.
            // @see docs/plans/multi-mode-v0.md §9
            let vivaMerchantId;
            let sourceCode;
            if (this.vivaConfig.mode === 'isv') {
                const { tenantId } = await this.tenantResolver.resolveTenantFromCart(cartLike);
                const account = await this.tenantResolver.resolveVivaAccount(tenantId);
                vivaMerchantId = account.vivaMerchantId;
                // ISV mode currently has no per-tenant sourceCode — use 'Default'.
                // TODO(slice-e): allow per-tenant sourceCode via tenant resolver.
                sourceCode = DEFAULT_SOURCE_CODE;
            }
            else {
                vivaMerchantId = undefined;
                sourceCode = this.vivaConfig.sourceCode ?? DEFAULT_SOURCE_CODE;
            }
            // Use Medusa's idempotency_key if provided, else use existing data's session id
            const medusaPaymentId = input.context?.idempotency_key ??
                input.data?.['session_id'] ??
                uuidv4();
            const idempotencyKey = medusaPaymentId;
            // P14 dedup: check existing transaction
            const repo = this.em.getRepository('VivaTransaction');
            const existing = await repo.findOne({ idempotency_key: idempotencyKey });
            if (existing &&
                existing.status !== 'initiated' &&
                existing.status !== 'failed') {
                // Idempotent re-call: return existing data
                const redirectUrl = existing.viva_order_code
                    ? buildCheckoutUrl(this.vivaConfig.environment, BigInt(existing.viva_order_code))
                    : null;
                return {
                    id: medusaPaymentId,
                    data: {
                        viva_transaction_id: existing.viva_transaction_id,
                        order_code: existing.viva_order_code ?? null,
                        redirect_url: redirectUrl,
                        viva_status: existing.status,
                    },
                };
            }
            // Compute amount in minor units.
            // Medusa passes amount as a BigNumber-compatible value.
            // @see references/viva-docs/md/isv-partner-program.txt:83 (P15 amounts)
            const amountMinor = BigInt(Math.round(Number(input.amount) * 100));
            const currencyCode = toCurrencyCode(input.currency_code);
            // A4 write-pending-first: INSERT before Viva API call.
            // viva_order_code is NULL until createOrder returns.
            // Migration_20260425000002 makes this column nullable.
            // @see references/viva-docs/md/isv-partner-program.txt:61 (A4)
            const vivaTransactionId = uuidv4();
            // Slice D made viva_merchant_id nullable. Merchant-mode rows store NULL
            // because there is no per-cart tenant merchant id — the plugin operates
            // a single account.
            // @see Migration_20260425000004_webhook_error_and_nullable_merchant
            const storedMerchantId = vivaMerchantId ?? null;
            if (!existing) {
                const now = new Date();
                const entity = repo.create({
                    viva_transaction_id: vivaTransactionId,
                    viva_order_code: null,
                    medusa_payment_id: medusaPaymentId,
                    viva_merchant_id: storedMerchantId,
                    status: 'initiated',
                    claim_substate: null,
                    amount_minor: amountMinor.toString(),
                    refunded_amount_minor: '0',
                    currency_code: currencyCode,
                    idempotency_key: idempotencyKey,
                    raw_payload: null,
                    created_at: now,
                    updated_at: now,
                });
                await this.em.persistAndFlush(entity);
            }
            // Step 5: call Viva createOrder.
            // - ISV mode: merchantId from tenant resolution; URL is /isv/orders.
            // - Merchant mode: merchantId omitted; URL is /checkout/v2/orders.
            // `Payments` silently ignores opts.merchantId in merchant mode.
            // @see references/viva-docs/md/payment-source-for-isv.txt:101
            const createResult = await this.isvPayments.createOrder({
                amount: amountMinor,
                currencyCode,
                merchantTrns: medusaPaymentId,
                customerTrns: `Payment via Viva Wallet`,
                sourceCode,
            }, {
                ...(vivaMerchantId !== undefined ? { merchantId: vivaMerchantId } : {}),
                idempotencyKey,
            });
            const orderCode = createResult.orderCode;
            // Step 6: update the pending row with the order code
            const txId = existing?.viva_transaction_id ?? vivaTransactionId;
            const txRow = await repo.findOne({ viva_transaction_id: txId });
            if (txRow) {
                txRow.viva_order_code = orderCode.toString();
                await this.em.flush();
            }
            // Step 7: build redirect URL and return.
            // Storefront reads data.redirect_url to redirect the customer.
            // @see references/viva-docs/md/smart-checkout-save-payment.txt:1
            const redirectUrl = buildCheckoutUrl(this.vivaConfig.environment, orderCode);
            return {
                id: medusaPaymentId,
                data: {
                    viva_transaction_id: txId,
                    order_code: orderCode.toString(),
                    redirect_url: redirectUrl,
                    viva_status: 'initiated',
                },
            };
        }
        catch (err) {
            throw toMedusaError(err);
        }
    }
    // --------------------------------------------------------------------------
    // authorizePayment
    // --------------------------------------------------------------------------
    /**
     * Consults the DB for the latest transaction status.
     * For Smart Checkout, authorization is off-band (redirect + webhook).
     * Called during cart-completion; returns current DB status.
     *
     * @see references/viva-docs/md/payment-isv-api.txt:1 (Smart Checkout flow)
     * @see references/viva-docs/md/isv-partner-program.txt:61 (P6 Smart Checkout)
     */
    async authorizePayment(input) {
        try {
            const medusaPaymentId = extractPaymentId(input.data);
            const repo = this.em.getRepository('VivaTransaction');
            const row = medusaPaymentId
                ? await repo.findOne({ medusa_payment_id: medusaPaymentId })
                : null;
            if (!row) {
                return { status: 'pending', data: input.data ?? {} };
            }
            const status = toMedusaStatus(row.status);
            return {
                status,
                data: {
                    ...(input.data ?? {}),
                    viva_transaction_id: row.viva_transaction_id,
                    order_code: row.viva_order_code ?? null,
                    viva_status: row.status,
                },
            };
        }
        catch (err) {
            throw toMedusaError(err);
        }
    }
    // --------------------------------------------------------------------------
    // capturePayment
    // --------------------------------------------------------------------------
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
    async capturePayment(input) {
        try {
            const medusaPaymentId = extractPaymentId(input.data);
            const repo = this.em.getRepository('VivaTransaction');
            const row = medusaPaymentId
                ? await repo.findOne({ medusa_payment_id: medusaPaymentId })
                : null;
            if (!row) {
                return { data: input.data ?? {} };
            }
            if (row.status === 'captured') {
                return {
                    data: {
                        ...(input.data ?? {}),
                        viva_transaction_id: row.viva_transaction_id,
                        order_code: row.viva_order_code ?? null,
                        viva_status: row.status,
                    },
                };
            }
            // Not yet captured — asynchronous via webhook 1796
            console.warn(`[viva] capturePayment called on transaction ${row.viva_transaction_id} ` +
                `with status '${row.status}' (not 'captured'). ` +
                `Smart Checkout capture happens asynchronously via Viva webhook 1796. ` +
                `No Viva API call made.`);
            return {
                data: {
                    ...(input.data ?? {}),
                    viva_transaction_id: row.viva_transaction_id,
                    order_code: row.viva_order_code ?? null,
                    viva_status: row.status,
                },
            };
        }
        catch (err) {
            throw toMedusaError(err);
        }
    }
    // --------------------------------------------------------------------------
    // refundPayment
    // --------------------------------------------------------------------------
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
    async refundPayment(input) {
        try {
            const medusaPaymentId = extractPaymentId(input.data);
            if (!medusaPaymentId) {
                throw new VivaValidationError({
                    message: 'refundPayment: medusa_payment_id is required in input.data',
                });
            }
            const repo = this.em.getRepository('VivaTransaction');
            const row = await repo.findOne({ medusa_payment_id: medusaPaymentId });
            if (!row) {
                throw new VivaValidationError({
                    message: `Transaction not found for medusa_payment_id '${medusaPaymentId}'`,
                });
            }
            if (row.status !== 'captured') {
                throw new VivaValidationError({
                    message: `Cannot refund transaction '${row.viva_transaction_id}': ` +
                        `status is '${row.status}', expected 'captured'.`,
                });
            }
            const capturedAmount = BigInt(row.amount_minor);
            const alreadyRefunded = BigInt(row.refunded_amount_minor);
            const available = capturedAmount - alreadyRefunded;
            // input.amount is BigNumberInput (number | string | BigNumber).
            // Convert to minor units (Medusa tracks amounts in currency major units for display).
            // TODO(impl): confirm whether Medusa passes refund amount in minor or major units.
            // Treating as major units (same as initiatePayment amount) for consistency.
            const refundAmountMinor = input.amount !== undefined && input.amount !== null
                ? BigInt(Math.round(Number(input.amount) * 100))
                : available; // full refund if amount not specified
            // P18 validation
            if (refundAmountMinor <= 0n) {
                throw new VivaValidationError({
                    message: `Refund amount must be > 0, got ${refundAmountMinor}.`,
                });
            }
            if (refundAmountMinor > available) {
                throw new VivaValidationError({
                    message: `Refund amount ${refundAmountMinor} exceeds available amount ${available} ` +
                        `(captured: ${capturedAmount}, already refunded: ${alreadyRefunded}). ` +
                        `Plan P18.`,
                });
            }
            // Get the Viva TransactionId for the refund endpoint.
            // The webhook handler (S8) stores this in raw_payload.TransactionId.
            // @see references/viva-docs/md/payment-isv-api.txt:1 (refund uses TransactionId)
            const vivaTransactionId = (row.raw_payload?.['TransactionId'] ??
                row.raw_payload?.['transactionId'] ??
                row.viva_transaction_id);
            // Build idempotency key for the refund: combines refund id + amount to prevent duplicates
            const medusaRefundId = input.data?.['medusa_refund_id'] ?? medusaPaymentId;
            const refundIdempotencyKey = `refund:${medusaRefundId}:${refundAmountMinor}`;
            // Branch refund path on mode:
            //   ISV mode → legacy/Basic refund via Payments.refundPayment (unchanged).
            //   Merchant mode → resolveRefundStrategy + FastRefundClient, with auto
            //     fallback to Standard (legacy/Basic) refund on HTTP 403.
            //
            // @see docs/ENDPOINTS.md §4 (Fast vs Standard matrix)
            // @see docs/plans/multi-mode-v0.md §9
            const rowMerchantId = row.viva_merchant_id;
            if (this.vivaConfig.mode === 'isv') {
                await this.isvPayments.refundPayment(vivaTransactionId, {
                    merchantId: rowMerchantId,
                    amountMinor: refundAmountMinor,
                    idempotencyKey: refundIdempotencyKey,
                });
            }
            else {
                await this.refundPaymentMerchantMode({
                    vivaTransactionId,
                    refundAmountMinor,
                    refundIdempotencyKey,
                    medusaRefundId,
                });
            }
            // Update refunded_amount_minor
            const newRefunded = alreadyRefunded + refundAmountMinor;
            row.refunded_amount_minor = newRefunded.toString();
            // Determine new status via lattice.
            // Full refund: captured → refunded. Partial: stays captured.
            // @see references/viva-docs/md/isv-partner-program.txt:296 (P18)
            const isFullRefund = newRefunded >= capturedAmount;
            if (isFullRefund) {
                const transition = validateStatusTransition(row.status, 'refunded');
                if (transition.ok) {
                    row.status = transition.next;
                }
            }
            await this.em.flush();
            return {
                data: {
                    ...(input.data ?? {}),
                    viva_transaction_id: row.viva_transaction_id,
                    order_code: row.viva_order_code ?? null,
                    viva_status: row.status,
                    refunded_amount_minor: newRefunded.toString(),
                },
            };
        }
        catch (err) {
            throw toMedusaError(err);
        }
    }
    // --------------------------------------------------------------------------
    // refundPaymentMerchantMode (slice B)
    // --------------------------------------------------------------------------
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
    async refundPaymentMerchantMode(params) {
        const { vivaTransactionId, refundAmountMinor, refundIdempotencyKey, medusaRefundId } = params;
        const configuredStrategy = this.vivaConfig.refundStrategy ?? 'auto';
        // Look up cardType from Viva to feed the strategy decision. Merchant mode
        // passes no merchantId — Payments ignores opts.merchantId when mode==='merchant'.
        let cardType;
        try {
            const tx = await this.isvPayments.retrieveTransaction(vivaTransactionId);
            cardType = tx.cardType;
        }
        catch (e) {
            // retrieveTransaction failure shouldn't block refund — log and proceed
            // with cardType=undefined, which lands on 'auto-no-card-info' → Standard.
            console.warn(`[viva] retrieveTransaction failed for refund '${vivaTransactionId}': ` +
                `${e instanceof Error ? e.message : String(e)}. ` +
                `Refund strategy will route via 'auto-no-card-info' (Standard).`);
        }
        const decision = resolveRefundStrategy(configuredStrategy, {
            ...(cardType !== undefined ? { cardType } : {}),
            isCardNotPresent: true, // Smart Checkout is always CNP
        });
        if (decision.kind === 'fast') {
            try {
                await this.fastRefundClient.refund({
                    transactionId: vivaTransactionId,
                    amount: refundAmountMinor,
                    sourceCode: this.vivaConfig.mode === 'merchant'
                        ? this.vivaConfig.sourceCode ?? DEFAULT_SOURCE_CODE
                        : DEFAULT_SOURCE_CODE,
                    merchantTrns: medusaRefundId,
                    idempotencyKey: refundIdempotencyKey,
                });
                return;
            }
            catch (err) {
                // 403 → either fall back (auto) or surface VIVA_FAST_REFUND_INELIGIBLE (fast).
                const is403 = err instanceof VivaApiError && err.httpStatus === 403;
                if (is403 && configuredStrategy === 'fast') {
                    throw new VivaApiError({
                        message: `Fast Refund ineligible (HTTP 403). Configured strategy 'fast' does not fall back. ` +
                            `Set VIVA_REFUND_STRATEGY=auto to enable automatic Standard-refund fallback.`,
                        httpStatus: 403,
                        vivaCode: 'VIVA_FAST_REFUND_INELIGIBLE',
                    });
                }
                if (!is403) {
                    throw err;
                }
                // is403 + strategy === 'auto' → fall through to Standard refund.
            }
        }
        // Standard refund — Payments.refundPayment routes through BasicAuthClient.
        // merchantId is required by the Payments method signature but ignored at
        // the wire layer for merchant mode (the legacy refund endpoint doesn't
        // carry merchantId in the URL).
        await this.isvPayments.refundPayment(vivaTransactionId, {
            merchantId: this.vivaConfig.legacyMerchantId,
            amountMinor: refundAmountMinor,
            idempotencyKey: refundIdempotencyKey,
        });
    }
    // --------------------------------------------------------------------------
    // cancelPayment
    // --------------------------------------------------------------------------
    /**
     * Cancels a Viva order (valid for unpaid orders not yet captured).
     * Idempotent: skip API call if already in terminal cancelled state.
     * Apply lattice: authorized → cancelled (A9 path).
     *
     * @see references/viva-docs/md/payment-isv-api.txt:1 (cancelOrder)
     * @see references/viva-docs/md/isv-partner-program.txt:61 (P18, A9)
     */
    async cancelPayment(input) {
        try {
            const medusaPaymentId = extractPaymentId(input.data);
            const repo = this.em.getRepository('VivaTransaction');
            const row = medusaPaymentId
                ? await repo.findOne({ medusa_payment_id: medusaPaymentId })
                : null;
            if (!row) {
                return { data: input.data ?? {} };
            }
            // Idempotent: already cancelled
            if (row.status === 'cancelled') {
                return {
                    data: {
                        ...(input.data ?? {}),
                        viva_transaction_id: row.viva_transaction_id,
                        viva_status: 'cancelled',
                    },
                };
            }
            // Validate the transition is allowed
            const transition = validateStatusTransition(row.status, 'cancelled');
            if (!transition.ok) {
                throw new VivaValidationError({
                    message: `Cannot cancel transaction '${row.viva_transaction_id}': ` +
                        `status '${row.status}' → 'cancelled' is not allowed (${transition.reason}). ` +
                        `Status lattice plan P17/A9.`,
                });
            }
            // Call Viva cancelOrder if order code is available.
            // - ISV mode: pass merchantId from the stored row → DELETE /checkout/v2/orders/{oc}?merchantId={uuid}.
            // - Merchant mode: omit merchantId → DELETE /checkout/v2/orders/{oc}.
            //   Payments silently ignores opts.merchantId in merchant mode anyway.
            if (row.viva_order_code) {
                const cancelOpts = this.vivaConfig.mode === 'isv'
                    ? { merchantId: row.viva_merchant_id }
                    : {};
                await this.isvPayments.cancelOrder(BigInt(row.viva_order_code), cancelOpts);
            }
            row.status = transition.next;
            await this.em.flush();
            return {
                data: {
                    ...(input.data ?? {}),
                    viva_transaction_id: row.viva_transaction_id,
                    order_code: row.viva_order_code ?? null,
                    viva_status: 'cancelled',
                },
            };
        }
        catch (err) {
            throw toMedusaError(err);
        }
    }
    // --------------------------------------------------------------------------
    // retrievePayment
    // --------------------------------------------------------------------------
    /**
     * Returns the serialized viva_transaction row for the given payment.
     *
     * @see references/viva-docs/md/isv-partner-program.txt:104
     */
    async retrievePayment(input) {
        try {
            const medusaPaymentId = extractPaymentId(input.data);
            const repo = this.em.getRepository('VivaTransaction');
            const row = medusaPaymentId
                ? await repo.findOne({ medusa_payment_id: medusaPaymentId })
                : null;
            if (!row) {
                return { data: {} };
            }
            return {
                data: {
                    viva_transaction_id: row.viva_transaction_id,
                    order_code: row.viva_order_code ?? null,
                    medusa_payment_id: row.medusa_payment_id,
                    status: row.status,
                    amount_minor: row.amount_minor,
                    refunded_amount_minor: row.refunded_amount_minor,
                    currency_code: row.currency_code,
                    created_at: row.created_at.toISOString(),
                    updated_at: row.updated_at.toISOString(),
                },
            };
        }
        catch (err) {
            throw toMedusaError(err);
        }
    }
    // --------------------------------------------------------------------------
    // getPaymentStatus
    // --------------------------------------------------------------------------
    /**
     * Returns the current Medusa-mapped payment status from the DB.
     *
     * @see references/viva-docs/md/isv-partner-program.txt:104
     */
    async getPaymentStatus(input) {
        try {
            const medusaPaymentId = extractPaymentId(input.data);
            const repo = this.em.getRepository('VivaTransaction');
            const row = medusaPaymentId
                ? await repo.findOne({ medusa_payment_id: medusaPaymentId })
                : null;
            if (!row) {
                return { status: 'pending' };
            }
            return {
                status: toMedusaStatus(row.status),
                data: {
                    viva_transaction_id: row.viva_transaction_id,
                    viva_status: row.status,
                },
            };
        }
        catch (err) {
            throw toMedusaError(err);
        }
    }
    // --------------------------------------------------------------------------
    // deletePayment
    // --------------------------------------------------------------------------
    /**
     * Logical-only deletion — does NOT delete the Viva transaction (audit trail).
     * The viva_transaction row is preserved for forensics and idempotency replay.
     *
     * @see references/viva-docs/md/isv-partner-program.txt:104
     */
    async deletePayment(input) {
        try {
            // Logical delete only — no Viva API call, no DB row deletion.
            // Audit trail must be preserved per plan design. Mode-agnostic.
            return { data: input.data ?? {} };
        }
        catch (err) {
            throw toMedusaError(err);
        }
    }
    // --------------------------------------------------------------------------
    // updatePayment
    // --------------------------------------------------------------------------
    /**
     * No-op for Smart Checkout: Viva orders cannot be updated after creation.
     * If amount changes, caller should cancel and re-initiate.
     *
     * @see references/viva-docs/md/payment-isv-api.txt:1 (order immutability)
     */
    async updatePayment(input) {
        try {
            // Smart Checkout orders are immutable once created. Mode-agnostic.
            // TODO(impl): log a warning if input.amount differs from the stored amount,
            // advising the operator to cancel and re-initiate.
            return {
                data: input.data ?? {},
            };
        }
        catch (err) {
            throw toMedusaError(err);
        }
    }
    // --------------------------------------------------------------------------
    // getWebhookActionAndData
    // --------------------------------------------------------------------------
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
    async getWebhookActionAndData(data) {
        try {
            const eventData = data.data;
            const eventTypeId = eventData?.['EventTypeId'];
            const innerEventData = eventData?.['EventData'];
            const sessionId = (innerEventData?.['MerchantTrns'] ??
                eventData?.['session_id']);
            // Map Viva event types to Medusa actions
            // TODO(impl): full webhook processing in S8 — this is a minimal stub
            // @see references/viva-docs/md/isv-partner-program.txt:104 (webhook event types)
            switch (eventTypeId) {
                case 1796: // Transaction Payment Created
                    return {
                        action: 'captured',
                        data: {
                            session_id: sessionId ?? '',
                            amount: 0,
                        },
                    };
                case 1797: // Transaction Reversal Created
                    return {
                        action: 'authorized',
                        data: {
                            session_id: sessionId ?? '',
                            amount: 0,
                        },
                    };
                case 1798: // Transaction Failed
                    return {
                        action: 'failed',
                        data: {
                            session_id: sessionId ?? '',
                            amount: 0,
                        },
                    };
                case 4865: // Order Updated (cancellation)
                    return {
                        action: 'canceled',
                        data: {
                            session_id: sessionId ?? '',
                            amount: 0,
                        },
                    };
                default:
                    return { action: 'not_supported' };
            }
        }
        catch (err) {
            return { action: 'failed' };
        }
    }
}
// ---------------------------------------------------------------------------
// Helper: extract medusa_payment_id from provider data
// ---------------------------------------------------------------------------
/**
 * Extracts the medusa_payment_id from the provider data bag.
 * Checks common keys set by our provider in previous calls.
 */
function extractPaymentId(data) {
    if (!data)
        return undefined;
    return (data['medusa_payment_id'] ??
        data['session_id']);
}
//# sourceMappingURL=service.js.map