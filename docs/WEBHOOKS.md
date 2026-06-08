# Viva Wallet Plugin — Webhooks Reference

> Inbound webhook events. Per-event payload shapes, plugin handler logic, dedupe + idempotency, auth model. Pair with `docs/ENDPOINTS.md` §10 (event catalogue + envelope) and `docs/STATE-MACHINE.md` (status lattice).

---

## 1. Envelope (all events)

Every event arrives as `POST /viva/webhook` with this shape:

```json
{
  "Url": "https://your-saas.com/viva/webhook",
  "EventData": { /* event-specific — see §3 */ },
  "Created": "2026-05-12T07:39:28.8496795Z",
  "CorrelationId": "21-245-DB33F8C9",
  "EventTypeId": 1796,
  "Delay": null,
  "RetryCount": 0,
  "RetryDelayInSeconds": null,
  "MessageId": "e8b09fc2-d4a4-43fc-8251-acd87ad04d96",
  "RecipientId": "bdf4c6b3-c26d-4046-b5df-5c443ec39d09",
  "MessageTypeId": 512
}
```

| Envelope field | Type | Plugin usage |
|---|---|---|
| `Url` | string | not used (sanity check during testing) |
| `EventData` | object | event-specific payload — see §3 |
| `Created` | ISO datetime (UTC) | timestamp for log correlation |
| `CorrelationId` | string | quote to Viva support |
| `EventTypeId` | int | dispatch key — picks the handler |
| `Delay` | int \| null | Viva-internal queueing delay; not used |
| `RetryCount` | int | Viva's retry attempt counter (≥1 means Viva is retrying delivery) |
| `RetryDelayInSeconds` | int \| null | not used |
| **`MessageId`** | UUID | **dedup key** (PK of `viva_webhook_event`) |
| `RecipientId` | UUID | Viva merchant/account that registered the webhook |
| `MessageTypeId` | int | Viva message category — not used by plugin |

### TypeScript types

All envelope and per-event payload types live in
`@sakeetech/viva-payments-core/types`:

```ts
import type {
  WebhookEnvelope,                              // generic envelope <EventData>
  VivaWebhookEnvelope,                          // discriminated union across all v1 event types
  TransactionPaymentCreatedEventData,           // 1796
  TransactionReversalCreatedEventData,          // 1797
  TransactionFailedEventData,                   // 1798
  OrderUpdatedEventData,                        // 4865
  AccountConnectedEventData,                    // 8193
  AccountVerificationStatusChangedEventData,    // 8194
} from '@sakeetech/viva-payments-core/types';

// Recommended pattern — discriminated union auto-narrows on EventTypeId:
const env: VivaWebhookEnvelope = JSON.parse(rawBody);
switch (env.EventTypeId) {
  case 1796: env.EventData.Amount;       // → TransactionPaymentCreatedEventData
  case 8193: env.EventData.SourceCode;   // → AccountConnectedEventData
}
```

> **Note for users of `@nkhind/vivawallet-sdk`.** Equivalence map:
> `VivaWebhookDatas<T>` → `WebhookEnvelope<T>`. Our union
> `VivaWebhookEnvelope` is keyed by literal `EventTypeId` (1796, 1797,
> 1798, 4865, 8193, 8194) instead of the broader `SmartCheckout` /
> `ConnectedAccount` groupings, so `switch (env.EventTypeId)` narrows
> `env.EventData` to the exact per-event shape without an extra cast.
> There is no need to add `@nkhind/vivawallet-sdk` as a dependency.

### Dedup rule

`MessageId` is the **only** dedup key. NOT `EventData.TransactionId`:

- Two events on the same transaction (e.g., 1796 capture and a later 1798 retry after a chargeback) share `TransactionId` but have different `MessageId`s.
- Viva retries delivery of the same event with the **same `MessageId`** when our receiver fails to return 200 within ~5s.

Plugin stores `MessageId` as primary key on `viva_webhook_event`. Receiver runs `INSERT ... ON CONFLICT (message_id) DO NOTHING` and only enqueues the worker job when the row is newly inserted.

---

## 2. Auth + verification

Webhook auth has **no HMAC and no body signing.** Two layers instead:

### 2.1 IP allowlist

Plugin's receiver checks the request source IP against Viva's published CIDRs. Default list is the union of demo + production CIDRs.

- Override via `webhookIpAllowlist` plugin option (e.g., when fronted by a proxy that rewrites source IP — then allowlist the proxy and verify Viva via X-Forwarded-For headers in the proxy layer instead).
- Mismatch → HTTP `403`, no envelope returned (don't leak shape to scanners). Logged.

### 2.2 URL-verify handshake

On registration AND periodic re-verification, Viva sends `GET /viva/webhook?key=...`. Plugin responds:

```json
{ "Key": "<webhook-verification-key>" }
```

The key was issued by Viva when the plugin registered the webhook URL:
- ISV mode: `GET /isv/v1/webhooks/token` (see `docs/ENDPOINTS.md` §7.1)
- Merchant/marketplace mode: `GET /api/messages/config/token` (see `docs/ENDPOINTS.md` §8.1)

Plugin stores the key in `VIVA_WEBHOOK_VERIFICATION_KEY` env. Don't rotate without re-registering — Viva will start refusing the receiver as unhealthy.

---

## 3. Per-event payload reference

Field names below come from the actual Viva sample bodies. PascalCase is wire format; the plugin's internal representation lowercases first letters.

### 3.1 `1796` — Transaction Payment Created

Fires when a customer completes Smart Checkout (success path).

**Modes:** M, I, MP.

**Plugin handler logic:**
1. Receiver INSERTs into `viva_webhook_event` (ON CONFLICT DO NOTHING).
2. Worker calls Retrieve Transaction (`GET /checkout/v2/transactions/{id}` or ISV variant).
3. Validate `amount === viva_transaction.amount_minor` → else `VIVA_AMOUNT_MISMATCH`, leave `processed_at NULL`.
4. Apply status transition `initiated → captured` via the lattice (see `docs/STATE-MACHINE.md`).
5. Transition Vendure/Medusa order: `ArrangingPayment → PaymentAuthorized → PaymentSettled`.
6. Mark `processed_at = now()`.

**Key `EventData` fields:**

| Field | Type | Plugin uses |
|---|---|---|
| `TransactionId` | UUID | retrieve, dedup-by-association |
| `OrderCode` | int (16-digit) | link back to `viva_transaction.order_code` |
| `MerchantId` | UUID | channel/store resolution (ISV mode) |
| `Amount` | int (minor units) | mismatch check vs local |
| `OriginalAmount` | int | reporting only |
| `CurrencyCode` | string (numeric ISO 4217) | mismatch check |
| `StatusId` | string | letter — `'F'` here (Finished); see `docs/STATE-MACHINE.md` |
| `TransactionTypeId` | int | category — see Viva's response-codes reference |
| `CardNumber` | string (masked, e.g., `414746XXXXXX0133`) | log + customer-facing reference |
| `CardType` *(not in sample but documented elsewhere)* | string | refund strategy decision (Visa/MC for Fast Refund) |
| `CardCountryCode` | string (ISO 3166-1 alpha-2) | fraud/risk signal |
| `CardIssuingBank` | string | informational |
| `Email`, `Phone`, `FullName` | string | customer reference — **DO NOT log raw** (see `docs/SECURITY.md`) |
| `SourceCode`, `SourceName` | string | channel attribution |
| `CustomerTrns`, `MerchantTrns` | string | descriptors |
| `InsDate` | ISO datetime | capture timestamp |
| `AuthorizationId` | string | log for chargeback correlation |
| `ServiceId` | int \| null | always null on 1796; relevant on 1797 (Fast Refund = 19) |
| `ConnectedAccountId` | UUID \| null | marketplace mode; null otherwise |
| `Tags` | string[] | passed through from `createOrder` body |
| `ResponseCode` | string | `"00"` = success; non-zero on 1798 |
| `Tip Amount`, `SurchargeAmount`, `TotalFee` | int | minor units |
| `Moto` | bool | mail-order/telephone-order flag |
| `Switching`, `Systemic`, `DualMessage` | bool | acquirer-internal flags; not used |

**Spec ref:** `references/viva-docs/md/wh-transaction-payment-created.txt:155`

### 3.2 `1798` — Transaction Payment Failed

Fires when Smart Checkout fails (declined, 3DS abandoned, customer back-button after auth, etc.).

**Modes:** M, I, MP.

**Plugin handler logic:**
1. Retrieve transaction (still — the failure may carry diagnostic info).
2. Apply status transition → `failed` (terminal). Stays in `ArrangingPayment` in the storefront state.
3. **Non-terminal for the storefront** — the order is NOT cancelled; customer can retry payment. Plugin marks `viva_transaction.status='failed'` but does not touch Vendure/Medusa order state beyond logging.

**Key `EventData` fields:** same shape as 1796 + the following:

| Field | Type | Plugin uses |
|---|---|---|
| `StatusId` | string | `'E'` here (Error) |
| `ResponseCode` | string | non-zero — e.g., `'05'` (declined), `'51'` (insufficient funds) |
| `ResponseEventId` | int \| null | links to a downstream `1799` Price Calculated or similar |
| `ServiceId` | int | populated on failed refund attempts (rare) |

**Spec ref:** `references/viva-docs/md/wh-transaction-failed.txt`

### 3.3 `1797` — Transaction Reversal Created

Fires after a successful refund (Fast or Standard).

**Modes:** M, I, MP.

**Plugin handler logic:**
1. Retrieve transaction to confirm refund amount.
2. Apply status transition `captured → refunded`.
3. Update Vendure `Payment` to `Refunded` state / Medusa equivalent.

**Distinguishing Fast vs Standard refund:**

| `EventData.ServiceId` | Refund type |
|---|---|
| `19` | Fast Refund (modern OAuth2 path) |
| `null` or other | Standard refund (Basic-auth `/api/transactions/{id}`) |

**Key `EventData` fields:** same envelope; `TransactionId` here is the **refund transaction**, distinct from the original payment's `TransactionId`. Use `ParentId` to walk back to the original.

| Field | Plugin uses |
|---|---|
| `TransactionId` | refund's own ID |
| `ParentId` | original payment's `TransactionId` |
| `Amount` | refund amount (may be partial) |
| `ServiceId` | refund-type discriminator (see above) |
| `OrderCode` | same as parent |

### 3.4 `4865` — Order Updated

Fires on order state changes — includes user-cancel from Smart Checkout, payment timeout, and admin actions in Viva Self Care.

**Modes:** M, I, MP.

**Plugin handler logic (partial — see open Q below):**
1. Read `EventData.StatusId`.
2. If status indicates cancellation (`X`, `C`, `E` — exact letter for user-cancel still TBD), transition the order back to `AddingItems` (or cancel) per the cancel flow.
3. If status indicates an admin update (e.g., partial settlement adjustment), reconcile.

**Open Q (still in `process-viva-webhook.handler.ts:447` TODO):** Viva's docs don't specify the lettered `StatusId` for "user clicked Cancel on the Smart Checkout page." Resolves on first observed live cancel event. Plugin defensively maps `{X, C, E}` to cancellation today.

**Key `EventData` fields:** OrderCode-centric (not transaction-centric):

| Field | Plugin uses |
|---|---|
| `OrderCode` | resolve `viva_transaction` row |
| `StatusId` | cancel detection |
| `Reason` *(if present)* | log |

### 3.5 `8193` — Account Connected

Fires when a connected account is created (post-`POST /isv/v1/accounts` or marketplace platform onboarding).

**Modes:** I, MP.

**Plugin handler logic:** log only. No state changes. The plugin already has the `accountId` from the synchronous response of `POST /isv/v1/accounts`; this webhook is informational confirmation.

**Spec ref:** `references/viva-docs/md/wh-account-connected.txt`

### 3.6 `8194` — Account Verification Status Changed

Fires when an ISV-connected merchant completes (or is rejected on) Viva's KYC.

**Modes:** I, MP.

**Plugin handler logic:**
1. Resolve channel/store by `EventData.ConnectedAccountId`.
2. If `Verified=true`:
   - Call `GET /isv/v1/accounts/{accountId}` to retrieve the verified account (the webhook itself does NOT carry `merchantId`; it must be fetched). The retrieved account body has the `merchantId` populated post-verification.
   - Write `vivaMerchantId = <merchantId from GET response>` to channel custom fields **first**.
   - Flip `vivaPayoutsEnabled = true` **last**.
   - Order matters — write `vivaMerchantId` before flipping `vivaPayoutsEnabled` so a partial failure leaves payouts disabled rather than enabled-but-unrouted.
3. If `Verified=false` (declined):
   - Leave `vivaMerchantId = null`.
   - Leave `vivaPayoutsEnabled = false`.
   - Log + alert. Operator must contact Viva.

**`EventData` fields (verified against `wh-account-verif-status-changed.txt:152` sample + `:186` parameter table):**

| Field | Type | Plugin uses |
|---|---|---|
| `Verified` | bool | gate decision — only field that drives state |
| `ConnectedAccountId` | UUID | channel/store lookup (this is the `accountId` from `POST /isv/v1/accounts`) |
| `PersonId` | UUID | Viva-internal person reference; not used by plugin |
| `PlatformPersonId` | UUID | Viva-internal platform reference; not used by plugin |

**`MerchantId` is NOT in the 8194 payload** — the handler must fetch via `GET /isv/v1/accounts/{accountId}` (see `docs/ENDPOINTS.md` §6.2). Don't try to read `EventData.MerchantId`.

**Spec ref:** `references/viva-docs/md/wh-account-verif-status-changed.txt`

### 3.7 `1799` — Transaction Price Calculated

Informational — fires when Viva calculates the final price after currency conversion (DCC) or installments.

**Modes:** M, I.

**Plugin handler logic:** none. Logged only.

### 3.8 `8448` — Transfer Created *(marketplace only, reserved)*

Fires when a marketplace transfer between connected accounts is created.

**Modes:** MP only.

**Plugin handler logic:** not implemented in v0.2.x. Receiver returns 200 + logs.

### 3.9 `1802` / `1803` — POS-ECR Session Created / Failed

Out of plugin scope (POS / card-present). Receiver returns 200 + logs; no handler.

### 3.10 Sale Transactions (HMAC-signed export webhook — `SaleTransactionsFileGenerated`)

Separate mechanism (`POST /dataservices/v1/webhooks/subscriptions`), HMAC-signed, used for nightly file exports. Plugin v0.2.x does NOT subscribe.

---

## 4. Receiver behavior in detail

### 4.1 GET /viva/webhook (verification handshake)

```
GET /viva/webhook?key=<probe-key>
```

Plugin always responds `200` with the configured verification key:

```json
{ "Key": "<VIVA_WEBHOOK_VERIFICATION_KEY>" }
```

**Does NOT** compare `?key=` to the stored key — Viva is verifying the server holds the key, not the other way around. The probe key in the URL is just noise.

### 4.2 POST /viva/webhook (event)

```
POST /viva/webhook
Content-Type: application/json
{ ... envelope ... }
```

Plugin response: always `200` with empty body, regardless of processing outcome. Viva treats anything non-200 (or no response within ~5s) as a delivery failure and retries with the same `MessageId`.

**Receive latency target:** <100ms. Worker processing happens off-thread (BullMQ / Medusa subscriber). Don't make Viva API calls in the receive path.

### 4.3 Job processing (async)

1. Acquire per-merchant semaphore (default 5 permits per `merchantId` per worker process). Multi-worker deployments inject a Redlock client.
2. Resolve channel/store by `EventData.MerchantId` (ISV) or by plugin config (merchant). Cache 60s.
3. Dispatch on `EventTypeId` to the appropriate handler.
4. Update `viva_webhook_event`:
   - Success → `processed_at = now()`, `error = NULL`.
   - Failure → `processed_at = NULL`, `error = <envelope JSON>`, `attempts++`.
5. Retryable failures requeue with exponential backoff up to N attempts (default 5).

---

## 5. Worker concurrency + ordering

| Property | Behaviour |
|---|---|
| **Per-merchant serialization** | Semaphore default = 5 permits per `merchantId`. Different merchants process in parallel. |
| **Per-transaction ordering** | NOT guaranteed by Viva. 1796 and 4865 for the same order can arrive in either order. Handlers must be **commutative w.r.t. terminal states** — once captured, a delayed 4865 cancel is a no-op (lattice blocks it). |
| **Stale-order re-walk** | If the order was rolled back to `AddingItems` by a sweep job before 1796 processed, the worker re-walks the state transitions to bring it back to `PaymentSettled`. |
| **Multi-worker safety** | `(message_id)` PK + per-`merchantId` Redlock prevents double-processing across worker processes. |

---

## 6. Health monitoring

`GET /viva/webhook/health` (both modes; requires admin token):

```json
{
  "events_received_24h": 42,
  "events_pending": 0,
  "oldest_pending_age_seconds": 0,
  "last_processed_at": "2026-05-12T10:01:23.000Z"
}
```

Prometheus metrics (`GET /viva/metrics`):

| Counter / gauge | Alert threshold |
|---|---|
| `viva_webhook_events_received_total` | — |
| `viva_webhook_events_processed_total{result="ok\|failed"}` | — |
| `viva_webhook_events_pending_total` | `> 10` for `> 5m` |
| `viva_webhook_processing_duration_seconds` (histogram) | p99 `> 2s` |
| `viva_amount_mismatch_total` | `> 0` — investigate |
| `viva_auth_refresh_errors_total` | `> 0` |

---

## 7. Testing

Sandbox fixtures live in:

```
packages/vendure-payment-viva/test/sandbox/fixtures/
packages/medusa-payment-viva/test/fixtures/
```

Files per event:

- `webhook-1796-payment-created.json`
- `webhook-1797-refund.json`
- `webhook-1798-failed.json`
- `webhook-4865-order-updated.json`
- `webhook-8193-account-connected.json`
- `webhook-8194-account-verification.json`
- `webhook-8194-account-verification-declined.json`

Refresh procedure (from real Viva captures):

1. Run plugin in `demo` environment against a Viva sandbox.
2. Capture raw webhook body from server logs (the `payload` column in `viva_webhook_event`).
3. Replace the fixture file's content.
4. **Sanitize** before commit:
   - `MerchantId` → `cccccccc-dddd-eeee-ffff-000000000001`
   - `AccountId` (8193/8194) → `eeeeeeee-ffff-0000-1111-222222222222`
   - `TransactionId` → `aaaaaaaa-1111-2222-3333-bbbbbbbbbbbb`
   - `OrderCode` → keep numeric shape; replace with `9999999999999999`
   - Mask card numbers `414746XXXXXX0133` format (never commit real PANs).
   - `Email` / `Phone` / `FullName` → `customer@example.com` / `7700900796` / `Sample Customer`.

---

## 8. References

- `docs/ENDPOINTS.md` §10 — event catalogue
- `docs/STATE-MACHINE.md` — status lattice + transitions
- `docs/ERRORS.md` — error envelope (for failed-job error rows)
- `docs/SECURITY.md` — auth model + logging discipline
- `references/viva-docs/md/webhooks-for-payments.txt` — Viva's webhook docs
- `references/viva-docs/md/wh-transaction-payment-created.txt:155` — 1796 sample
- `references/viva-docs/md/wh-transaction-failed.txt` — 1798 sample
- `references/viva-docs/md/wh-account-connected.txt` — 8193 sample
- `references/viva-docs/md/wh-account-verif-status-changed.txt` — 8194 sample
- `packages/viva-payments-core/src/webhooks/` — verification, event types
- `packages/*/src/jobs/process-viva-webhook.handler.ts` — adapter handler logic

---

## 9. Changelog (this document)

- 2026-05-12 — initial. Full envelope + per-event payload reference for the events the plugin handles. Sourced from `references/viva-docs/md/wh-*.txt` samples and the in-tree handler code.
