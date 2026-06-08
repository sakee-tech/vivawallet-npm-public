/**
 * FastRefundClient — Viva Fast Refund API (OAuth2 acquiring scopes).
 *
 * Wraps `POST /acquiring/v1/transactions/{transactionId}:fastrefund` on the
 * v2 API surface. Requires an OAuth2 token with `acquiring` +
 * `acquiring:transactions` scopes (see AUTH.md §3.2). Eligibility is
 * server-enforced by Viva:
 *   - Visa / MasterCard / Maestro card schemes
 *   - E-commerce (card-not-present) transactions
 *   - Merchant must be approved by Viva sales for fast refunds
 *
 * If the merchant is not approved or the original transaction is not eligible,
 * Viva returns HTTP 403. Callers are expected to catch the resulting
 * `VivaApiError` and fall back to the standard (legacy) refund path. See
 * {@link resolveRefundStrategy} for the upstream pure decision helper.
 *
 * Design notes:
 *   - Caller-driven fallback: this client never silently retries on a
 *     standard refund — caller decides whether to fall back.
 *   - Idempotent: `false`. POST is non-idempotent at the transport layer; no
 *     4xx/5xx retries. Connection-level errors retry once (request never acked).
 *   - Mirrors the style of {@link BasicAuthClient.request} / Payments.refundPayment
 *     for validation, error handling, and JSDoc references.
 *
 * @see docs/ENDPOINTS.md §4 (Fast vs Standard refund matrix)
 * @see docs/AUTH.md §3.2 (OAuth2 acquiring scopes)
 * @see docs/plans/multi-mode-v0.md §8.5a (FastRefundClient class shape)
 * @see docs/STATE-MACHINE.md §3.1 (card-scheme detection)
 * @see references/payment-api.yaml:9255 (POST /acquiring/v1/transactions/{id}:fastrefund)
 * @see references/payment-api.yaml:9268 (eligibility — Visa/MC/Maestro)
 */

import type { IsvHttpClient } from '../isv/client.js';
import type { TransactionId, MinorUnits } from '../types/index.js';
import { VivaValidationError } from '../errors/index.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface FastRefundClientConfig {
  /**
   * OAuth2 HTTP client whose underlying AuthStrategy yields a token with
   * `acquiring` + `acquiring:transactions` scopes (see AUTH.md §3.2).
   */
  client: IsvHttpClient;
}

/**
 * Input for {@link FastRefundClient.refund}.
 *
 * All fields are required — Fast Refund does not support a "full refund by
 * omission" convention (unlike the legacy refund path). Pass the original
 * transaction's full amount in minor units for a full refund.
 */
export interface FastRefundRequest {
  /** UUID of the ORIGINAL captured transaction to refund. */
  transactionId: TransactionId;
  /** Amount in integer minor units. Must be > 0. */
  amount: MinorUnits;
  /** Payment source code (Viva merchant source). Non-empty string. */
  sourceCode: string;
  /** Merchant-side reference for the refund. Non-empty string. */
  merchantTrns: string;
  /**
   * Idempotency key. Forwarded as the `Idempotency-Key` HTTP header per the
   * shared {@link IsvHttpClient} convention. Non-empty string.
   *
   * NOTE: Viva does not appear to deduplicate server-side (probe F2,
   * 2026-04-25). Local dedup remains the authoritative mechanism. Header is
   * retained for forward-compat.
   */
  idempotencyKey: string;
}

/**
 * Response from {@link FastRefundClient.refund}.
 *
 * Field names are normalized to camelCase. Viva responds with a transaction
 * envelope describing the REFUND transaction (a new transaction id, distinct
 * from the original `transactionId` passed in the request).
 *
 * @see references/payment-api.yaml:9255
 */
export interface FastRefundResponse {
  /** The refund transaction's OWN id (not the original captured transaction). */
  transactionId: TransactionId;
  /** Viva event id correlated with the refund. */
  eventId: number;
  /** Refunded amount in minor units, as JSON number from Viva. */
  amount: number;
}

// ---------------------------------------------------------------------------
// FastRefundClient
// ---------------------------------------------------------------------------

/**
 * Thin POST wrapper for the Viva Fast Refund endpoint.
 *
 * Eligibility (per Viva docs):
 *   - Visa / MasterCard / Maestro
 *   - E-commerce (card-not-present)
 *   - Merchant approved by Viva sales for Fast Refunds
 *
 * On 403 the caller should fall back to the standard refund flow
 * (`Payments.refundPayment` via the legacy `BasicAuthClient`). The decision
 * helper {@link resolveRefundStrategy} returns `auto-ineligible-*` reasons up
 * front so most ineligible cases never reach the wire.
 *
 * @see references/payment-api.yaml:9255
 * @see docs/ENDPOINTS.md §4
 * @see docs/AUTH.md §3.2
 */
export class FastRefundClient {
  private readonly client: IsvHttpClient;

  constructor(config: FastRefundClientConfig) {
    this.client = config.client;
  }

  /**
   * POST `/acquiring/v1/transactions/{transactionId}:fastrefund`.
   *
   * Body: `{ amount, sourceCode, merchantTrns, idempotencyKey }` — no extra
   * fields. Auth: OAuth2 Bearer (acquiring scopes) handled by the underlying
   * {@link IsvHttpClient}.
   *
   * Local validation (throws VivaValidationError before HTTP call):
   *   - `amount` must be > 0 minor units
   *   - `sourceCode`, `merchantTrns`, `idempotencyKey` must be non-empty strings
   *
   * Errors:
   *   - 403  → VivaApiError. Caller decides whether to fall back to standard refund.
   *   - 404  → VivaApiError (transaction not found).
   *   - 422  → VivaApiError (invalid BIN / scheme).
   *   - 423  → VivaApiError (refund already in progress).
   *   - 452  → VivaApiError (insufficient funds for fast refund).
   *   - 5xx  → VivaApiError (no retry — POST is non-idempotent).
   *
   * @see references/payment-api.yaml:9255
   * @see docs/ERRORS.md §2 (error code matrix)
   */
  async refund(input: FastRefundRequest): Promise<FastRefundResponse> {
    // --- local validation (mirror style of Payments.refundPayment / createOrder) ---
    if (input.amount <= 0n) {
      throw new VivaValidationError({
        message: `FastRefundClient.refund: amount must be > 0 minor units, got ${input.amount}`,
      });
    }
    if (typeof input.sourceCode !== 'string' || input.sourceCode.length === 0) {
      throw new VivaValidationError({
        message: 'FastRefundClient.refund: sourceCode must be a non-empty string',
      });
    }
    if (typeof input.merchantTrns !== 'string' || input.merchantTrns.length === 0) {
      throw new VivaValidationError({
        message: 'FastRefundClient.refund: merchantTrns must be a non-empty string',
      });
    }
    if (typeof input.idempotencyKey !== 'string' || input.idempotencyKey.length === 0) {
      throw new VivaValidationError({
        message: 'FastRefundClient.refund: idempotencyKey must be a non-empty string',
      });
    }
    if (typeof input.transactionId !== 'string' || input.transactionId.length === 0) {
      throw new VivaValidationError({
        message: 'FastRefundClient.refund: transactionId must be a non-empty string',
      });
    }

    // URL-encode the transactionId so the path segment is safe even for ids
    // that contain reserved characters (defensive — Viva UUIDs do not, but
    // the type is a branded string so future ids could).
    const encodedId = encodeURIComponent(input.transactionId);
    const path = `/acquiring/v1/transactions/${encodedId}:fastrefund`;

    // Wire body — exactly the four fields per spec. `amount` is bigint and
    // is handled by the shared bigint-safe stringify in IsvHttpClient.
    const body = {
      amount: input.amount,
      sourceCode: input.sourceCode,
      merchantTrns: input.merchantTrns,
      idempotencyKey: input.idempotencyKey,
    };

    // Response shape per Viva docs: PascalCase or camelCase fields are both
    // accepted defensively. Field naming convention on the acquiring API is
    // camelCase per the OpenAPI spec.
    type FastRefundRaw = {
      transactionId?: string;
      TransactionId?: string;
      eventId?: number;
      EventId?: number;
      amount?: number;
      Amount?: number;
    };

    const raw = await this.client.request<FastRefundRaw>({
      method: 'POST',
      path,
      body,
      idempotencyKey: input.idempotencyKey,
      idempotent: false,
      endpoint: 'POST /acquiring/v1/transactions/{transactionId}:fastrefund',
    });

    const refundTxId = (raw.transactionId ?? raw.TransactionId ?? '') as TransactionId;
    const eventId = (raw.eventId ?? raw.EventId ?? 0) as number;
    const amount = (raw.amount ?? raw.Amount ?? 0) as number;

    return {
      transactionId: refundTxId,
      eventId,
      amount,
    };
  }
}
