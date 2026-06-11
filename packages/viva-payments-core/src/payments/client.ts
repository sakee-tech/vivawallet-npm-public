/**
 * Payments — Viva Payment API methods (mode-aware).
 *
 * The class is parameterised by `mode: 'merchant' | 'isv'`. URL paths and
 * query-string contracts switch per mode:
 *
 *   createOrder
 *     merchant → POST /checkout/v2/orders                       (OAuth2)
 *     isv      → POST /checkout/v2/isv/orders?merchantId={uuid} (OAuth2)
 *   retrieveTransaction
 *     merchant → GET /checkout/v2/transactions/{transactionId}                (OAuth2)
 *     isv      → GET /checkout/v2/isv/transactions/{transactionId}?merchantId={uuid} (OAuth2)
 *   cancelOrder
 *     merchant → DELETE /checkout/v2/orders/{orderCode}                       (OAuth2)
 *     isv      → DELETE /checkout/v2/orders/{orderCode}?merchantId={uuid}     (OAuth2)
 *   refundPayment
 *     both     → POST /api/transactions/{transactionId}                       (Legacy/Basic)
 *
 * In merchant mode `opts.merchantId` (if passed) is silently ignored — never
 * added to the query string. In ISV mode `merchantId` is required and a
 * VivaValidationError is thrown if absent.
 *
 * `CreateOrderRequest.isvAmount` is stripped from the wire body when
 * `mode === 'merchant'` — only forwarded on the ISV `/isv/orders` path.
 *
 * All methods validate inputs locally before making HTTP calls.
 * Amounts are in integer minor units (bigint) per plan P15.
 *
 * Idempotency: createOrder and refundPayment are non-idempotent (idempotent: false).
 * retrieveTransaction and cancelOrder are idempotent.
 *
 * --- Refund path (F1 — probe-verified 2026-04-25) ---
 * Viva returns 405 on `POST /checkout/v2/transactions/{id}` (v2/OAuth2 path).
 * The ONLY working refund path is `POST /api/transactions/{transactionId}` on the
 * LEGACY HOST (`demo.vivapayments.com` / `www.vivapayments.com`) with Basic auth
 * (MerchantId + ApiKey). The 401-fallback design is NOT applicable here — Viva
 * returns 405 (not 401) on the v2 path, so no fallback would ever trigger.
 * refundPayment now calls `legacyClient` DIRECTLY without any v2 attempt.
 *
 * @see references/viva-docs/md/tut-create-recurring-payment.txt:288 (legacy refund endpoint)
 *
 * --- retrieveTransaction / cancelOrder fallback (D15 — kept defensive) ---
 *   The optional `secondaryClient` is a fallback for retrieveTransaction and
 *   cancelOrder. When the primary OAuth2 client returns 401 (after force-refresh),
 *   the call retries once with the secondary client. A 401 from secondary surfaces
 *   as VivaAuthError — no further retry.
 *   Note: cancelOrder is unverified against live sandbox as of 2026-04-25 probe;
 *   kept on OAuth2 + 401-fallback path defensively.
 *
 * --- Idempotency-Key header (F2 — probe-verified 2026-04-25) ---
 *   The `Idempotency-Key` header is sent on createOrder but Viva does NOT appear
 *   to deduplicate server-side (same key returned two different orderCodes in probe).
 *   Local dedup via `viva_transaction` row is the authoritative dedup mechanism.
 *   Header is retained for forward-compat (zero cost, may be honoured in future).
 *
 * @see references/viva-docs/md/payment-isv-api.txt:1
 * @see references/viva-docs/md/webhooks-for-payments.txt:248 (retrieve before update)
 * @see references/viva-docs/md/isv-partner-program.txt:104 (ISV overview)
 * @see references/viva-docs/md/isv-credentials.txt:107 (reseller credentials)
 * @see docs/plans/vendure-plugin-v0.md §D15 (reseller fallback scope)
 */

import type { IsvHttpClient } from '../isv/client.js';
import type { BasicAuthClient } from '../legacy/client.js';
import type {
  CreateOrderRequest,
  CreateOrderResponse,
  RetrieveTransactionResponse,
  RefundResponse,
  CancelOrderResponse,
  MerchantId,
  TransactionId,
  OrderCode,
  MinorUnits,
} from '../types/index.js';
import { VivaValidationError, VivaAuthError } from '../errors/index.js';
import { resolveCardType } from '../types/card-types.js';

// ---------------------------------------------------------------------------
// Validation helpers
// ---------------------------------------------------------------------------

/**
 * Validates an ISO 4217 numeric currency code (3-digit numeric string).
 *
 * Per plan P15: currencyCode must be a valid 3-digit numeric string.
 * Examples: '978' (EUR), '826' (GBP), '840' (USD).
 *
 * @see references/viva-docs/md/webhooks-for-payments.txt:487
 */
function isValidCurrencyCode(code: string): boolean {
  return /^\d{3}$/.test(code);
}

// ---------------------------------------------------------------------------
// Mode + URL builders
// ---------------------------------------------------------------------------

/**
 * Payment surface mode.
 *
 *   - `merchant` — Single-merchant integration. URLs do NOT include the
 *     `/isv` segment and do NOT carry `merchantId` query parameter. The
 *     OAuth2 token is scoped to a single merchant account.
 *   - `isv`      — ISV/partner integration. URLs include the `/isv` segment
 *     where applicable and carry `merchantId={uuid}` to scope the call to a
 *     specific connected merchant.
 *
 * @see docs/AUTH.md §3.1
 * @see docs/ENDPOINTS.md §2.1 / §2.2
 */
export type PaymentsMode = 'merchant' | 'isv';

/**
 * Configuration for the {@link Payments} client.
 *
 * - `mode` REQUIRED. Determines URL paths + query-string contract.
 * - `client` primary OAuth2 client.
 * - `secondaryClient` optional 401-fallback client for retrieveTransaction
 *   and cancelOrder (reseller basic-auth scenario; see D15).
 * - `legacyClient` REQUIRED for refundPayment in both modes (legacy host +
 *   Basic auth — v2 path returns 405).
 */
export interface PaymentsConfig {
  readonly mode: PaymentsMode;
  readonly client: IsvHttpClient;
  readonly secondaryClient?: IsvHttpClient;
  readonly legacyClient?: BasicAuthClient;
}

/**
 * Result of a URL-builder helper: a path template (without query) plus a
 * query parameter map. Query is empty for merchant mode.
 */
interface BuiltUrl {
  readonly path: string;
  readonly query: Record<string, string>;
}

/**
 * Build the path + query for `POST /checkout/v2/(isv/)orders`.
 *
 * In ISV mode `merchantId` is REQUIRED — throws VivaValidationError if absent.
 * In merchant mode `merchantId` is ignored entirely.
 */
function buildOrderCreateUrl(mode: PaymentsMode, merchantId: string | undefined): BuiltUrl {
  switch (mode) {
    case 'merchant':
      return { path: '/checkout/v2/orders', query: {} };
    case 'isv':
      if (!merchantId) {
        throw new VivaValidationError({
          message: "createOrder: merchantId is required when mode='isv'",
        });
      }
      return { path: '/checkout/v2/isv/orders', query: { merchantId } };
  }
}

/**
 * Build the path + query for `GET /checkout/v2/(isv/)transactions/{id}`.
 *
 * In ISV mode `merchantId` is REQUIRED — throws VivaValidationError if absent.
 * In merchant mode `merchantId` is ignored entirely.
 */
function buildTransactionRetrieveUrl(
  mode: PaymentsMode,
  transactionId: string,
  merchantId: string | undefined,
): BuiltUrl {
  switch (mode) {
    case 'merchant':
      return { path: `/checkout/v2/transactions/${transactionId}`, query: {} };
    case 'isv':
      if (!merchantId) {
        throw new VivaValidationError({
          message: "retrieveTransaction: merchantId is required when mode='isv'",
        });
      }
      return {
        path: `/checkout/v2/isv/transactions/${transactionId}`,
        query: { merchantId },
      };
  }
}

/**
 * Build the path + query for `DELETE /checkout/v2/orders/{orderCode}`.
 *
 * Both modes share the same path template; only ISV mode appends the
 * `merchantId` query parameter (and requires it).
 */
function buildOrderCancelUrl(
  mode: PaymentsMode,
  orderCode: bigint | string | number,
  merchantId: string | undefined,
): BuiltUrl {
  const path = `/checkout/v2/orders/${orderCode}`;
  switch (mode) {
    case 'merchant':
      return { path, query: {} };
    case 'isv':
      if (!merchantId) {
        throw new VivaValidationError({
          message: "cancelOrder: merchantId is required when mode='isv'",
        });
      }
      return { path, query: { merchantId } };
  }
}

// ---------------------------------------------------------------------------
// Payments
// ---------------------------------------------------------------------------

/**
 * Viva Payment API client (mode-aware).
 *
 * Constructed with a {@link PaymentsConfig}. The `mode` field determines URL
 * paths and query-string contract per slice 2 of the multi-mode refactor.
 *
 * - `mode`: `'merchant'` or `'isv'`. Required.
 * - `client`: primary OAuth2 client for createOrder, retrieveTransaction, cancelOrder.
 * - `secondaryClient`: optional 401-fallback for retrieveTransaction and cancelOrder.
 *   When undefined, 401 errors propagate normally.
 * - `legacyClient`: REQUIRED for refundPayment. Calls `POST /api/transactions/{id}`
 *   on the legacy host with Basic auth (MerchantId + ApiKey). If absent, refundPayment
 *   throws `VIVA_REFUND_REJECTED` with a config-missing message.
 *
 * Probe-verified 2026-04-25: refund MUST go through legacy client — v2/OAuth2 path
 * returns 405. cancelOrder is unverified but kept on v2/OAuth2 + 401-fallback defensively.
 *
 * @see docs/plans/multi-mode-v0.md §8.1
 * @see references/viva-docs/md/tut-create-recurring-payment.txt:288 (legacy refund path)
 * @see references/viva-docs/md/payment-isv-api.txt:1
 * @see references/viva-docs/md/isv-partner-program.txt:61 (P1: merchant scoping)
 * @see references/viva-docs/md/isv-credentials.txt:107 (reseller credentials)
 * @see docs/plans/vendure-plugin-v0.md §D15 (reseller fallback)
 */
export class Payments {
  private readonly mode: PaymentsMode;
  private readonly client: IsvHttpClient;
  private readonly secondaryClient: IsvHttpClient | undefined;
  private readonly legacyClient: BasicAuthClient | undefined;

  constructor(config: PaymentsConfig) {
    this.mode = config.mode;
    this.client = config.client;
    this.secondaryClient = config.secondaryClient;
    this.legacyClient = config.legacyClient;
  }

  /**
   * Create a payment order for a specific ISV merchant.
   *
   * Sends a POST /checkout/v2/orders?merchantId={merchantId} request.
   * The `Idempotency-Key` header is sent on every call but Viva does NOT appear
   * to deduplicate server-side as of 2026-04-25 (probe: same key → two different
   * orderCodes). Local dedup via `viva_transaction` row is the authoritative
   * dedup mechanism. Header retained for forward-compat only.
   *
   * Input validation (throws VivaValidationError before HTTP call):
   *   - amountMinor must be > 0 (per plan P15)
   *   - currencyCode must be a valid 3-digit numeric string (per plan P15)
   *
   * Non-idempotent: does not retry on 4xx/5xx (only connection-level errors).
   *
   * @see references/viva-docs/md/payment-isv-api.txt:1
   * @see references/viva-docs/md/isv-partner-program.txt:61 (P14 idempotency)
   * @see references/viva-docs/md/isv-partner-program.txt:83 (P15 amounts)
   */
  async createOrder(
    req: CreateOrderRequest,
    opts: { merchantId?: MerchantId; idempotencyKey: string },
  ): Promise<CreateOrderResponse> {
    // Local validation per P14 and P15
    if (req.amount <= 0n) {
      throw new VivaValidationError({
        message: `createOrder: amountMinor must be > 0, got ${req.amount}`,
      });
    }
    if (!isValidCurrencyCode(req.currencyCode)) {
      throw new VivaValidationError({
        message: `createOrder: currencyCode must be a 3-digit numeric string (ISO 4217), got "${req.currencyCode}"`,
      });
    }

    // Resolve URL per mode. Throws VivaValidationError in ISV mode if
    // merchantId is missing. In merchant mode `opts.merchantId` is silently
    // ignored — back-compat for adapters that still pass it.
    const { path, query } = buildOrderCreateUrl(this.mode, opts.merchantId);

    // Build wire body: convert bigint amount to number for JSON.
    // Amount in minor units is always within safe integer range for real payments.
    const wireBody: Record<string, unknown> = {
      amount: req.amount, // bigintSafeStringify in client handles this
      currencyCode: Number(req.currencyCode), // Viva expects numeric currency code as number
    };
    if (req.merchantTrns !== undefined) wireBody['merchantTrns'] = req.merchantTrns;
    if (req.customerTrns !== undefined) wireBody['customerTrns'] = req.customerTrns;
    // Customer identity is a NESTED object on Viva's Smart Checkout createOrder
    // body: `customer: { email, fullName, phone, countryCode, requestLang }`.
    // Emitting these at the top level (as earlier versions did) made Viva
    // silently drop them — the same footgun as successUrl/failureUrl below.
    // @see docs/internal/payment-isv-api.yaml:380 (customer object)
    const customer: Record<string, unknown> = {};
    if (req.customerEmail !== undefined) customer['email'] = req.customerEmail;
    if (req.customerPhone !== undefined) customer['phone'] = req.customerPhone;
    if (req.customerFullName !== undefined) customer['fullName'] = req.customerFullName;
    if (Object.keys(customer).length > 0) wireBody['customer'] = customer;
    // NOTE: `successUrl` / `failureUrl` are intentionally NOT emitted. Viva's
    // Smart Checkout createOrder body (`Create_New_Payment_Order_v2_schema`) has
    // no generic success/failure redirect field — only `urlFail` + `stateId=1`
    // (redirect on EXPIRY). The post-payment redirect target is a property of the
    // payment SOURCE (`pathSuccess` / `pathFail`, set via POST /api/sources), not
    // of an individual order. Sending `successUrl` / `failureUrl` here just
    // shipped fields Viva silently dropped — a footgun that made the plugin
    // config look load-bearing when it was inert. See
    // sakee-tech/vivawallet-npm-public#15. The fields remain on the request type
    // (deprecated) for source-compat but are never transmitted.
    if (req.tags !== undefined) wireBody['tags'] = req.tags;
    if (req.sourceCode !== undefined) wireBody['sourceCode'] = req.sourceCode;
    if (req.paymentTimeoutSeconds !== undefined) wireBody['paymentTimeout'] = req.paymentTimeoutSeconds;
    // NOTE: `preselectedPaymentMethod` is intentionally NOT emitted. No such field
    // exists on Viva's Smart Checkout createOrder body (grep of payment-api.yaml +
    // payment-isv-api.yaml: zero hits). Sending it just shipped a field Viva
    // silently dropped — the same footgun as successUrl/failureUrl above. The field
    // remains on the request type (deprecated) for source-compat but is never
    // transmitted. Payment-method preselection is done via the checkout URL /
    // source configuration, not the order body.
    // ISV-only: `isvAmount` only emitted in ISV mode. Strip in merchant mode
    // even if caller passed it (forward-compat shim for shared adapter code).
    if (this.mode === 'isv' && req.isvAmount !== undefined) {
      wireBody['isvAmount'] = req.isvAmount;
    }

    const raw = await this.client.request<{ orderCode?: OrderCode; OrderCode?: OrderCode }>({
      method: 'POST',
      path,
      query,
      body: wireBody,
      idempotencyKey: opts.idempotencyKey,
      idempotent: false, // per plan Auth Flow line 319
      endpoint: `POST ${path}`,
    });

    // Viva's modern checkout/v2 create-order response returns the code as
    // lowercase `orderCode` (verified live + OpenAPI); read both casings
    // defensively, as retrieveTransaction already does. Reading only
    // `OrderCode` here silently dropped the code on every real response,
    // orphaning the order on Viva's side. (sakee-tech/vivawallet-npm-public#9)
    return { orderCode: (raw.orderCode ?? raw.OrderCode) as OrderCode };
  }

  /**
   * Retrieve transaction details for a specific ISV merchant transaction.
   *
   * Per Viva docs, this SHOULD be called before updating any local transaction
   * status on receipt of a webhook. Validates orderCode and statusId from Viva.
   *
   * Idempotent: safe to retry on 429 and 5xx.
   *
   * Path + auth verified 2026-04-25 (F3):
   *   `GET /checkout/v2/transactions/{transactionId}` with OAuth2 Bearer → correct.
   *   404 error envelope shape: `{"status": 404, "message": null, "eventId": "0"}`.
   *   Note: `message` can be null — handle defensively.
   *
   * 401 → reseller fallback (D15) — kept DEFENSIVE:
   *   If the primary OAuth2 client receives a 401 and secondaryClient is configured,
   *   the request is retried once with the secondary (Reseller basic-auth) client.
   *   A 401 from the secondary surfaces immediately as VivaAuthError — no further retry.
   *   The primary path is verified working; fallback is defensive for edge-case tenants.
   *
   * @see references/viva-docs/md/webhooks-for-payments.txt:248 (retrieve before update)
   * @see references/viva-docs/md/payment-isv-api.txt:1
   * @see references/viva-docs/md/isv-credentials.txt:107 (reseller basic-auth)
   * @see docs/plans/vendure-plugin-v0.md §D15 (reseller fallback scope)
   */
  async retrieveTransaction(
    transactionId: TransactionId,
    opts: { merchantId?: MerchantId } = {},
  ): Promise<RetrieveTransactionResponse> {
    // Resolve URL per mode. In merchant mode `opts.merchantId` is silently
    // ignored. In ISV mode it is required.
    const { path, query } = buildTransactionRetrieveUrl(
      this.mode,
      transactionId,
      opts.merchantId,
    );

    const endpointTemplate =
      this.mode === 'isv'
        ? 'GET /checkout/v2/isv/transactions/{transactionId}'
        : 'GET /checkout/v2/transactions/{transactionId}';

    const requestOpts = {
      method: 'GET' as const,
      path,
      query,
      idempotent: true,
      endpoint: endpointTemplate,
    };

    // Viva API returns PascalCase field names (e.g. OrderCode, StatusId).
    // We normalize to camelCase matching RetrieveTransactionResponse.
    // The bigint-safe parser in IsvHttpClient already converts OrderCode to bigint.
    let raw: Record<string, unknown>;
    try {
      raw = await this.client.request<Record<string, unknown>>(requestOpts);
    } catch (err) {
      // 401 → reseller fallback (D15). Only attempt if secondaryClient is present.
      // A 401 from the secondary surfaces immediately — no further retry.
      // @see docs/plans/vendure-plugin-v0.md §D15
      // @see references/viva-docs/md/isv-credentials.txt:107
      if (err instanceof VivaAuthError && err.httpStatus === 401 && this.secondaryClient) {
        raw = await this.secondaryClient.request<Record<string, unknown>>(requestOpts);
      } else {
        throw err;
      }
    }

    // Normalize: accept both PascalCase (wire) and camelCase (normalized) field names.
    // @see references/viva-docs/md/account-api.txt:1584 (OrderCode: long)
    const orderCode = (raw['orderCode'] ?? raw['OrderCode']) as OrderCode;
    const cardNumber = raw['cardNumber'] ?? raw['CardNumber'];
    const cardTypeId = raw['cardTypeId'] ?? raw['CardTypeId'];
    const email = raw['email'] ?? raw['Email'];
    const fullName = raw['fullName'] ?? raw['FullName'];
    const merchantTrns = raw['merchantTrns'] ?? raw['MerchantTrns'];
    const customerTrns = raw['customerTrns'] ?? raw['CustomerTrns'];
    const connectedAccountId = raw['connectedAccountId'] ?? raw['ConnectedAccountId'];

    // Derive cardType (string scheme name) from Viva's numeric cardTypeId.
    // Pure mapping via resolveCardType — undefined when id is absent, a
    // sentinel (Invalid/Unknown), or otherwise unmapped.
    // @see ../types/card-types.ts
    // @see ../refunds/strategy.ts (consumer)
    const cardType =
      typeof cardTypeId === 'number' ? resolveCardType(cardTypeId) : undefined;

    // Build with conditional optional fields to satisfy exactOptionalPropertyTypes.
    // (Cannot assign to readonly Partial<> properties so we use spread.)
    return {
      // The v2 GET transaction response does NOT echo transactionId in the body
      // (not in the `transactions` schema, payment-isv-api.yaml:6258). Fall back to
      // the path-parameter id the caller passed in — mirrors refundPayment.
      transactionId: (raw['transactionId'] ?? raw['TransactionId'] ?? transactionId) as TransactionId,
      orderCode,
      statusId: (raw['statusId'] ?? raw['StatusId']) as string,
      amount: BigInt(((raw['amount'] ?? raw['Amount']) as number | bigint) ?? 0) as MinorUnits,
      currencyCode: (raw['currencyCode'] ?? raw['CurrencyCode']) as import('../types/index.js').CurrencyCode,
      merchantId: (raw['merchantId'] ?? raw['MerchantId']) as string,
      parentId: ((raw['parentId'] ?? raw['ParentId']) as TransactionId | null | undefined) ?? null,
      insDate: (raw['insDate'] ?? raw['InsDate'] ?? '') as string,
      transactionTypeId: ((raw['transactionTypeId'] ?? raw['TransactionTypeId']) as number) ?? 0,
      ...(typeof cardNumber === 'string' ? { cardNumber } : {}),
      ...(typeof cardTypeId === 'number' ? { cardTypeId } : {}),
      ...(cardType !== undefined ? { cardType } : {}),
      ...(typeof email === 'string' ? { email } : {}),
      ...(typeof fullName === 'string' ? { fullName } : {}),
      ...(typeof merchantTrns === 'string' ? { merchantTrns } : {}),
      ...(typeof customerTrns === 'string' ? { customerTrns } : {}),
      ...(typeof connectedAccountId === 'string' ? { connectedAccountId } : {}),
    };
  }

  /**
   * Issue a full or partial refund (Viva's "Cancel transaction") for a captured
   * transaction.
   *
   * CONTRACT (verified against the OpenAPI specs on disk):
   *   `DELETE /api/transactions/{transactionId}` on the LEGACY HOST
   *   (`demo.vivapayments.com` / `www.vivapayments.com`) with Basic auth.
   *   Parameters go in the QUERY STRING, not a body:
   *     `?amount={minorUnits}&sourceCode={code}&currencyCode={iso4217-numeric}`
   *   Success is indicated by `StatusId === 'F'` (finished/finalised).
   *   @see docs/internal/payment-api.yaml:8592      (merchant Cancel transaction)
   *   @see docs/internal/payment-isv-api.yaml:2640   (ISV Cancel transaction)
   *
   * AUTH per mode (the caller wires the correct `legacyClient`):
   *   - merchant: Merchant Basic — `base64(MerchantId:ApiKey)`.
   *   - isv:      Reseller Basic — `base64(ResellerId:ConnectedMerchantId:ResellerApiKey)`.
   *     The Reseller ID/Key are issued by Viva (demo + production pairs differ)
   *     and are distinct from the dashboard ISV credentials.
   *     @see docs/internal/payment-isv-api.yaml:2650 (reseller auth structure)
   *
   *   This method calls `legacyClient` DIRECTLY; the OAuth2 401-fallback does not
   *   apply. If `legacyClient` is absent, throws VivaValidationError.
   *
   * Amount handling:
   *   - Partial refund: provide `amountMinor > 0` → emitted as `?amount=`.
   *   - Full refund: omit `amountMinor` → `amount` query param omitted. Viva
   *     treats a missing amount as a full refund (Viva Support, 2026-06-11),
   *     though the ISV OpenAPI marks `amount` required; callers that want strict
   *     conformance should pass the full captured amount explicitly.
   *
   *   - ISV fee reverses automatically on refund (isv-partner-program.txt:296).
   *   - Failed refund (4xx) surfaces as VivaApiError; payment NOT marked refunded.
   *
   * Non-idempotent: does not retry on 4xx/5xx.
   *
   * Viva response fields (PascalCase, mapped to camelCase):
   *   StatusId → statusId, Amount → amount, TransactionId → transactionId.
   *
   * @see references/viva-docs/md/isv-partner-program.txt:296 (ISV fee reversal on refund)
   */
  async refundPayment(
    transactionId: TransactionId,
    opts: {
      merchantId: MerchantId;
      amountMinor?: MinorUnits;
      sourceCode?: string;
      /** ISO 4217 numeric currency code (e.g. 978 for EUR). Optional. */
      currencyCode?: number;
      idempotencyKey: string;
      /**
       * Per-call Basic-auth client override. ISV mode passes a Reseller-variant
       * client built with the *connected* merchant's UUID, since the refund must
       * authenticate as the reseller scoped to that merchant. When omitted, the
       * construction-time `legacyClient` (Merchant Basic) is used.
       */
      legacyClient?: BasicAuthClient;
    },
  ): Promise<RefundResponse> {
    // Local validation per P18
    if (opts.amountMinor !== undefined && opts.amountMinor <= 0n) {
      throw new VivaValidationError({
        message: `refundPayment: amountMinor must be > 0 when specified, got ${opts.amountMinor}`,
      });
    }

    // legacyClient REQUIRED for refund — DELETE /api/transactions/{id} on the
    // legacy host with Basic auth. Merchant mode: Merchant Basic (construction
    // time). ISV mode: the caller passes a Reseller-variant client per-call via
    // opts.legacyClient (Viva-issued reseller creds + connected merchant UUID).
    const legacyClient = opts.legacyClient ?? this.legacyClient;
    if (!legacyClient) {
      throw new VivaValidationError({
        message:
          'refundPayment requires a legacyClient (Basic auth). ' +
          'Merchant mode: configure the Merchant Basic pair (MerchantId + ApiKey). ' +
          'ISV mode: configure the Viva-issued Reseller pair (resellerId + resellerApiKey).',
      });
    }

    // Build query string for the DELETE Cancel-transaction call.
    // - amount: send only for partial refund; omit for full refund.
    // - sourceCode: defaults to 'Default' (the source the refund is applied to).
    // - currencyCode: optional ISO 4217 numeric (multicurrency refunds).
    // @see docs/internal/payment-isv-api.yaml:2673 (query parameters)
    const query: Record<string, string | number | bigint | undefined> = {
      sourceCode: opts.sourceCode ?? 'Default',
    };
    if (opts.amountMinor !== undefined) {
      // Viva endpoint expects amount in minor units as integer.
      query['amount'] = opts.amountMinor;
    }
    if (opts.currencyCode !== undefined) {
      query['currencyCode'] = opts.currencyCode;
    }

    // PascalCase response from Viva legacy API.
    type LegacyRefundRaw = {
      TransactionId?: string;
      StatusId?: string;
      Amount?: number;
    };

    const result = await legacyClient.request<LegacyRefundRaw>({
      method: 'DELETE',
      path: `/api/transactions/${transactionId}`,
      query,
      idempotent: false, // non-idempotent — no 4xx/5xx retry
      endpoint: 'DELETE /api/transactions/{transactionId}',
    });

    const raw = result.data;

    // Map PascalCase → camelCase and return typed RefundResponse.
    return {
      transactionId: (raw.TransactionId ?? transactionId) as TransactionId,
      ...(raw.StatusId !== undefined ? { statusId: raw.StatusId } : {}),
      ...(raw.Amount !== undefined ? { amount: BigInt(raw.Amount) as MinorUnits } : {}),
    };
  }

  /**
   * Cancel an order that has not yet been paid.
   *
   * Idempotent per Viva docs: calling cancel on an already-cancelled or
   * captured order returns the existing Viva response without error.
   *
   * Per plan P18: cancellation triggers webhook 4865 (Order Updated).
   *
   * Path: `DELETE /checkout/v2/orders/{orderCode}?merchantId={merchantId}` (OAuth2).
   *
   * UNVERIFIED against live sandbox as of 2026-04-25 probe. Only
   * cancel-transaction (refund/reverse) was tested; cancel-order was not.
   * Kept on v2/OAuth2 + 401-fallback path defensively.
   *
   * 401 → reseller fallback (D15) — kept DEFENSIVE:
   *   If the primary OAuth2 client receives a 401 and secondaryClient is configured,
   *   the request is retried once with the secondary (Reseller basic-auth) client.
   *   A 401 from the secondary surfaces immediately as VivaAuthError — no further retry.
   *
   * Note: if cancelOrder already succeeded on Viva's side before any 401 is
   * observed, a 4xx from Viva on a subsequent attempt signals the order is
   * already cancelled (idempotent). The fallback does NOT apply to non-401
   * errors — those propagate as VivaApiError unchanged.
   *
   * @see references/viva-docs/md/payment-isv-api.txt:1
   * @see references/viva-docs/md/webhooks-for-payments.txt:205 (4865 Order Updated)
   * @see references/viva-docs/md/isv-credentials.txt:107 (reseller basic-auth)
   * @see docs/plans/vendure-plugin-v0.md §D15 (reseller fallback scope)
   */
  async cancelOrder(
    orderCode: OrderCode,
    opts: { merchantId?: MerchantId } = {},
  ): Promise<CancelOrderResponse> {
    type CancelRaw = { OrderCode: OrderCode; ErrorCode: number; ErrorText: string };

    // Resolve URL per mode. In merchant mode `opts.merchantId` is silently
    // ignored. In ISV mode it is required.
    const { path, query } = buildOrderCancelUrl(this.mode, orderCode, opts.merchantId);

    const requestOpts = {
      method: 'DELETE' as const,
      path,
      query,
      idempotent: true as const, // idempotent per Viva docs
      endpoint: 'DELETE /checkout/v2/orders/{orderCode}',
    };

    let raw: CancelRaw;
    try {
      raw = await this.client.request<CancelRaw>(requestOpts);
    } catch (err) {
      // 401 → reseller fallback (D15). Only attempt if secondaryClient is present.
      // A 401 from the secondary surfaces immediately — no further retry.
      // @see docs/plans/vendure-plugin-v0.md §D15
      // @see references/viva-docs/md/isv-credentials.txt:107
      if (err instanceof VivaAuthError && err.httpStatus === 401 && this.secondaryClient) {
        raw = await this.secondaryClient.request<CancelRaw>(requestOpts);
      } else {
        throw err;
      }
    }

    return {
      orderCode: raw.OrderCode,
      errorCode: raw.ErrorCode,
      errorText: raw.ErrorText,
    };
  }
}
