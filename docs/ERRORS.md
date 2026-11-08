# Viva Wallet Plugin — Error Reference

> Canonical catalogue of every error code the plugin family emits. Two layers: **adapter-level plugin errors** (consumer-facing, single envelope shape) and **SDK-level error classes** (thrown by `viva-payments-core`, mapped to envelopes by adapters).
>
> Both adapters (Vendure + Medusa) emit the same envelope shape and use the same `VIVA_*` codes. Source of truth.

---

## 1. The envelope

All plugin errors — REST responses, job failures, GraphQL mutation results — share one shape:

```ts
type VivaPluginError = {
  code: VivaErrorCode;          // 'VIVA_AUTH_DOWN' | 'VIVA_API_ERROR' | …
  message: string;              // human-readable, may include parameter values
  retryable: boolean;           // does it make sense for the caller to retry?
  vivaErrorCode?: number;       // Viva's own error code, when available
  vivaErrorMessage?: string;    // Viva's own error message, when available
  cause?: unknown;              // upstream Error for stack trace (not serialized)
};
```

### Serialization rules

- **REST responses** flatten the envelope into the response body and set HTTP status per §2 column. `retryable: true` → HTTP `5xx`; `retryable: false` → HTTP `4xx` (with one exception: `VIVA_INTERNAL_ERROR` is `500` and `retryable: false` — it's a bug, not a transient).
- **Job failures** (BullMQ / Medusa async) store the envelope on the `viva_webhook_event.error` column as JSON. `processed_at` stays `NULL` for retryable errors so the job picks up on next sweep.
- **GraphQL mutations** (Vendure `cancelPayment`) return the envelope flattened into the `CancelPaymentError` union member: `errorCode` (= `code`), `message`, `vivaErrorCode`, `vivaErrorMessage`. The `retryable` flag is lost in this serialization (GraphQL clients infer from `errorCode`).
- **Log lines** emit the full envelope plus `cause.stack` if present. PII fields (customer email/phone, masked PAN) are NEVER included automatically; if an upstream message contains them, the adapter MUST scrub before logging.

---

## 2. Plugin error codes (adapter level)

Sorted by code. All codes prefixed `VIVA_`. Stable contract — codes are not renamed across minor versions.

| Code | HTTP | Retryable | When it fires |
|---|---|---|---|
| `VIVA_AUTH_DOWN` | 503 | yes | OAuth2 token unavailable at bootstrap or runtime (Viva 5xx / timeout / network error on `POST /connect/token`). Plugin already retried once with cache miss; this surfaces only when retry also failed. |
| `VIVA_API_ERROR` | 502 | no | Viva returned a `4xx` not covered by a more specific code below. Plugin passes through `errorCode` + `message` from Viva's response into `vivaErrorCode` / `vivaErrorMessage`. |
| `VIVA_ACCOUNT_NOT_VERIFIED` | 400 | no | (ISV mode) `createPayment` called on a channel/store where `vivaPayoutsEnabled=false` or `vivaMerchantId` is missing. Tell the operator to wait for webhook 8194 or call the reconcile endpoint. |
| `VIVA_ISV_AMOUNT_TOO_HIGH` | 400 | no | (ISV mode) Plugin's pre-call guard rejected the request because `resolveIsvAmount(order, ctx) >= order.amount`. Viva would have returned an error anyway; plugin fails fast to give a better message. |
| `VIVA_CHANNEL_MISCONFIGURED` | 400 | no | (ISV mode) `resolveMerchantId(ctx)` returned `undefined` for a channel/store that has no `vivaMerchantId` custom field set. |
| `VIVA_ORDER_NOT_FOUND` | 404 | no | (a) Retrieve Transaction returned 404 (transaction ID doesn't exist on Viva); OR (b) Vendure/Medusa Payment row was deleted before the webhook processed. |
| `VIVA_AMOUNT_MISMATCH` | 422 | no | Webhook job path: Retrieve Transaction returned `amount != viva_transaction.amount_minor`. Webhook event row's `processed_at` stays `NULL` and `error` carries this code. Investigate before retrying. |
| `VIVA_REFUND_REJECTED` | 422 | no | Viva returned a `4xx` on the refund call (either Fast Refund 4xx or Standard refund Basic-auth 4xx). Includes Viva's own `errorCode` + `message`. |
| `VIVA_PAYMENT_ALREADY_SETTLED` | 409 | no | Settle attempted on a payment already in `Settled` state. Likely double-fired webhook; plugin's local dedup should prevent this — surfacing this code means dedup missed. |
| `VIVA_PAYMENT_NOT_CANCELLABLE` | 409 | no | Cancel attempted on a payment in a non-cancellable state (already settled, already cancelled). Vendure/Medusa state guard. |
| `VIVA_ALREADY_ONBOARDED` | 409 | no | (ISV mode) `POST /viva/admin/connected-accounts` called on a channel that already has `vivaAccountId`. Use the reconcile endpoint to refresh existing onboarding state. |
| `VIVA_INTERNAL_ERROR` | 500 | no | Catch-all. Indicates a bug — the plugin should never reach this in production. `cause` carries the original exception. Log + alert. |

### Codes added in v0.2.0 (multi-mode)

| Code | HTTP | Retryable | When it fires |
|---|---|---|---|
| `VIVA_FAST_REFUND_INELIGIBLE` | 403 | no | (`refundStrategy='fast'` only) Card scheme isn't Visa/MC, or transaction isn't card-not-present, or merchant isn't approved for Fast Refund. With `'auto'` strategy this is caught internally and the plugin falls back to Standard refund — never surfaces to the caller. |
| `VIVA_SOURCE_CREATION_FAILED` | 422 | no | `POST /api/sources` returned 4xx. Includes Viva's `errorCode` + `message`. |
| `VIVA_MODE_MISMATCH` | 400 | no | Caller invoked an ISV-only endpoint (e.g., `POST /viva/admin/connected-accounts`) when plugin is configured in `merchant` mode. |
| `VIVA_RESELLER_CREDENTIALS_MISSING` | 412 | no | ISV-mode `POST /viva/admin/connected-accounts/:id/sources` called without `reseller` config — required for the Reseller Basic auth to `/api/sources`. |

---

## 3. SDK error classes (`viva-payments-core/errors`)

Thrown by core; adapters catch and map to the plugin envelope above. Don't surface these directly to consumers.

| Class | `.code` | Extends | Thrown when |
|---|---|---|---|
| `VivaError` | (abstract base) | `Error` | Never thrown directly — base class for all SDK errors. |
| `VivaAuthError` | `VIVA_AUTH_ERROR` | `VivaError` | Token issuance failed; token refresh failed after retry. Adapter maps → `VIVA_AUTH_DOWN`. |
| `VivaApiError` | `VIVA_API_ERROR` | `VivaError` | Viva returned non-2xx on an OAuth2 endpoint. Adapter maps to one of `VIVA_API_ERROR`, `VIVA_ORDER_NOT_FOUND`, `VIVA_REFUND_REJECTED`, etc. based on HTTP status + Viva error code. |
| `VivaValidationError` | `VIVA_VALIDATION_ERROR` | `VivaError` | Local validation failed (e.g., invalid currency code, missing required field in `loadConfigFromEnv`, `isvAmount >= amount` pre-call guard). Adapter maps → `VIVA_ISV_AMOUNT_TOO_HIGH`, `VIVA_CHANNEL_MISCONFIGURED`, or rethrows for config-loader path. |
| `VivaWebhookError` | `VIVA_WEBHOOK_ERROR` | `VivaError` | Webhook payload failed validation (missing `MessageId`, bad envelope shape). Adapter maps → `VIVA_INTERNAL_ERROR` (webhook receiver always returns 200 regardless; this surfaces in logs only). |
| `VivaRateLimitError` | `VIVA_RATE_LIMIT_ERROR` | `VivaError` | Viva returned `429 Too Many Requests`. Adapter maps → `VIVA_API_ERROR` with `retryable: true` (overridden — the only API-error path that retries). |

### SDK class fields

```ts
class VivaError extends Error {
  abstract readonly code: string;
  readonly cause?: unknown;
}

class VivaApiError extends VivaError {
  readonly code = 'VIVA_API_ERROR';
  readonly httpStatus: number;
  readonly vivaErrorCode?: number;
  readonly vivaErrorMessage?: string;
  readonly responseBody?: unknown;
}

class VivaRateLimitError extends VivaApiError {
  readonly code = 'VIVA_RATE_LIMIT_ERROR';
  readonly retryAfterMs?: number;   // from Retry-After header, if present
}
```

---

## 4. Mapping rules — Viva → plugin

How the adapter chooses a plugin code from a Viva response.

### 4.1 OAuth2 endpoints (`/checkout/v2/...`, `/isv/v1/...`, `/acquiring/v1/...`)

| Viva response | Plugin code |
|---|---|
| `401` (after one force-refresh retry) | `VIVA_AUTH_DOWN` |
| `404` | `VIVA_ORDER_NOT_FOUND` |
| `405` on `POST /checkout/v2/transactions/{id}` | (don't surface — caller should never hit this; if it does, `VIVA_INTERNAL_ERROR` because refund path selection is broken) |
| `429` | `VIVA_API_ERROR` with `retryable: true` |
| `4xx` on refund endpoint | `VIVA_REFUND_REJECTED` |
| `4xx` on source endpoint | `VIVA_SOURCE_CREATION_FAILED` |
| `4xx` otherwise | `VIVA_API_ERROR` |
| `5xx` | `VIVA_API_ERROR` with `retryable: true` |
| network/timeout | `VIVA_AUTH_DOWN` (if on token endpoint) / `VIVA_API_ERROR` retryable (otherwise) |

### 4.2 Basic-auth endpoints (`/api/transactions/{id}`, `/api/sources`)

| Viva response | Plugin code |
|---|---|
| `401` | `VIVA_API_ERROR` (auth mis-configured — operator must fix credentials, retry won't help) |
| `404` | `VIVA_ORDER_NOT_FOUND` (refund) / `VIVA_API_ERROR` (sources) |
| `4xx` on refund | `VIVA_REFUND_REJECTED` |
| `4xx` on sources | `VIVA_SOURCE_CREATION_FAILED` |
| `5xx` | `VIVA_API_ERROR` retryable |

### 4.3 Webhook receiver

| Condition | Behaviour |
|---|---|
| Source IP not in allowlist | HTTP `403`. No envelope returned (don't leak shape to scanners). Logged. |
| URL-verify GET probe with bad `key` | HTTP `200` with empty body. Don't return the key on a mismatched probe. |
| `MessageId` already exists | HTTP `200`. INSERT-OR-IGNORE no-op. |
| Job processing throws | Webhook row's `error` column gets the envelope (JSON); HTTP response is still `200` (Viva expects 200 within ~5s). |

### 4.4 Viva passing through its own error code

When Viva returns a 4xx with a JSON body like:

```json
{ "errorCode": 23, "errorMessage": "Customer cancelled the transaction" }
```

The adapter places these in the envelope:

```ts
{
  code: 'VIVA_API_ERROR',
  message: 'Customer cancelled the transaction',
  retryable: false,
  vivaErrorCode: 23,
  vivaErrorMessage: 'Customer cancelled the transaction',
}
```

A reference of Viva's own error codes lives at `developer.viva.com/integration-reference/response-codes/` — not duplicated here.

---

## 5. Retry semantics

| Caller | What "retryable" means |
|---|---|
| **Webhook job worker (BullMQ / Medusa async)** | `retryable: true` → job is requeued with exponential backoff up to N attempts (default 5). `retryable: false` → job is marked failed; row stays in `viva_webhook_event` with `processed_at=NULL` and operator intervention required. |
| **REST callers (admin endpoints)** | `retryable: true` (`5xx`) → caller should retry after a short delay. `retryable: false` (`4xx`) → caller must change the request, not retry. |
| **GraphQL clients (Shop API `cancelPayment`)** | No retryable field exposed. Client treats any `CancelPaymentError` as terminal; operator-led retry only. |
| **Storefront** | `5xx` → show "Try again" UX. `4xx` → show "Couldn't process — contact support" UX. Don't auto-retry user-initiated calls. |

---

## 6. Operator playbook

### Diagnosing "payment stuck in Created"

1. Check `GET /viva/webhook/health` — look at `events_pending`, `oldest_pending_age_seconds`.
2. Query `viva_webhook_event WHERE processed_at IS NULL AND error IS NOT NULL`.
3. Read the `error` column JSON envelope:

| `code` | Action |
|---|---|
| `VIVA_AMOUNT_MISMATCH` | Investigate amount divergence between local `viva_transaction` and Viva. Could be a currency rounding error, partial-capture confusion, or fraud. Do NOT auto-clear the error. |
| `VIVA_ORDER_NOT_FOUND` | Transaction was deleted from Viva (rare) or the `viva_transaction` row points at a wrong ID. Reconcile manually. |
| `VIVA_AUTH_DOWN` | Viva or your OAuth2 credentials are unavailable. Check `/viva/internal/auth-status`. Once auth recovers, clear `error` + `processed_at=NULL` to re-enqueue. |
| `VIVA_API_ERROR` with `retryable: true` | Already auto-retried; surfaces here only after max attempts. Manual re-enqueue safe. |
| `VIVA_CHANNEL_MISCONFIGURED` | ISV mode: `merchantId` was missing at processing time. Call reconcile endpoint, then clear and re-enqueue. |
| `VIVA_API_ERROR` with non-retryable + `vivaErrorCode` | Look up the Viva error code at `developer.viva.com/integration-reference/response-codes/`. Likely customer/card-side issue; do not retry. |

### Manual re-enqueue

Schema differs between adapters — use the right column names.

**Vendure** (`viva_webhook_event` entity has `error`, `retryCount`, `processed_at`):

```sql
UPDATE viva_webhook_event
SET processed_at = NULL, error = NULL, retry_count = 0
WHERE message_id = '<uuid>';
```

**Medusa** (`viva_webhook_event` model has `processed_at`, `message_id`, `raw_payload` only — no `error` or attempts column; the absence is itself the retry signal):

```sql
UPDATE viva_webhook_event
SET processed_at = NULL
WHERE message_id = '<uuid>';
```

The next sweep / scheduled retry will pick it up. Vendure: BullMQ retry config; Medusa: subscriber retry strategy.

> **Schema note (drift to resolve in v0.2.0):** Medusa's `viva_webhook_event` should grow `error` (text) and `retry_count` (int) columns to match Vendure and to enable the operator playbook above.

### Hard failures that block onboarding

| Code | Common cause | Fix |
|---|---|---|
| `VIVA_ALREADY_ONBOARDED` on `POST /viva/admin/connected-accounts` | Channel already has `vivaAccountId`. | Use reconcile endpoint to refresh state, or delete the existing record after Viva-side disconnect (manual). |
| `VIVA_RESELLER_CREDENTIALS_MISSING` on source creation | ISV mode without `reseller` block in config. | Add reseller credentials to plugin init options. |
| `VIVA_MODE_MISMATCH` | Caller invoked ISV admin endpoint in merchant-mode plugin. | Either flip `mode: 'isv'` (and provide ISV credentials) or remove the call from the caller. |

---

## 7. Logging discipline

When emitting any error envelope to logs:

- **DO** include: `code`, `message`, `retryable`, `vivaErrorCode`, `vivaErrorMessage`, channel/store identity, `messageId` (for webhook errors), `paymentId`/`orderCode` (for payment errors), `cause.stack`.
- **DO NOT** include: full webhook body, full transaction response body, customer email/phone (use a hash or `[redacted]`), masked PAN beyond first 6 + last 4, raw cookies, raw Authorization headers, or any `.env` value.

Scrubbing is the adapter's responsibility — if a `cause` carries a Viva response body with PII, the envelope's `message` field MUST be a sanitized summary, not a pass-through.

---

## 8. References

- `packages/viva-payments-core/src/errors/` — SDK error classes (source of truth for SDK codes)
- `packages/vendure-payment-viva/src/util/error-envelope.ts` — plugin envelope factories (source of truth for adapter codes)
- `packages/medusa-payment-viva/src/...` — Medusa adapter envelope wiring (mirrors Vendure)
- `docs/AUTH.md` — auth schemes (context for `VIVA_AUTH_DOWN`)
- `docs/ENDPOINTS.md` §13 — probe-verified findings affecting error mapping (F1: 405 on v2 refund)
- `docs/GLOSSARY.md` — term disambiguation
- `developer.viva.com/integration-reference/response-codes/` — Viva's own error code catalogue (not duplicated here)

---

## 9. Changelog (this document)

- 2026-05-12 — initial. Extracted plugin codes from `packages/vendure-payment-viva/src/util/error-envelope.ts` and SDK codes from `packages/viva-payments-core/src/errors/`. Added v0.2.0 codes (`VIVA_FAST_REFUND_INELIGIBLE`, `VIVA_SOURCE_CREATION_FAILED`, `VIVA_MODE_MISMATCH`, `VIVA_RESELLER_CREDENTIALS_MISSING`) as planned per `multi-mode-v0.md` §6.
