# Viva Wallet — Endpoints Reference

> Canonical matrix of every Viva endpoint the plugin family uses, organised by purpose. Pair with [`docs/AUTH.md`](./AUTH.md) for auth scheme details.
>
> Sourced from `docs/payment-api.yaml` (merchant + marketplace OpenAPI, 16k lines) and `docs/payment-isv-api.yaml` (ISV OpenAPI, 7.6k lines), both pulled 2026-05-12. Probe-verified findings noted inline.

---

## Conventions

- **Hosts** are abbreviated:
  - `{oauth-token}` = `demo-accounts.vivapayments.com` (demo) / `accounts.vivapayments.com` (live)
  - `{oauth-api}` = `demo-api.vivapayments.com` (demo) / `api.vivapayments.com` (live)
  - `{basic-api}` = `demo.vivapayments.com` (demo) / `www.vivapayments.com` (live)
- **Modes** column lists which plugin operational modes use the endpoint: `M` = merchant, `I` = ISV, `MP` = marketplace (reserved, v0.2.x doesn't ship).
- **Auth** column references schemes documented in `docs/AUTH.md` §1.
- All amounts are **minor units** (integer; e.g., `1234` = €12.34).
- Currency codes are **ISO 4217 numeric** outbound (`978` = EUR, `826` = GBP, `840` = USD).
- All UUIDs are lowercase, hyphenated.

---

## Table of contents

1. [Authentication](#1-authentication)
2. [Smart Checkout — create order](#2-smart-checkout--create-order)
3. [Transactions — retrieve / cancel](#3-transactions--retrieve--cancel)
4. [Refunds](#4-refunds)
5. [Payment Sources](#5-payment-sources)
6. [ISV — Connected Accounts](#6-isv--connected-accounts)
7. [ISV — Webhook registration](#7-isv--webhook-registration)
8. [Merchant — Webhook helper](#8-merchant--webhook-helper)
9. [Marketplace — Platform endpoints *(reserved)*](#9-marketplace--platform-endpoints-reserved)
10. [Incoming webhook events](#10-incoming-webhook-events)
11. [Deprecated endpoints](#11-deprecated-endpoints)
12. [Quick lookup by task](#12-quick-lookup-by-task)
13. [Probe-verified findings](#13-probe-verified-findings)
14. [References](#14-references)

---

## 1. Authentication

### 1.1 OAuth2 token

```
POST https://{oauth-token}/connect/token
```

| | |
|---|---|
| **Auth** | HTTP Basic with `client_id:client_secret` (form-encoded body alternative also accepted) |
| **Body** | `grant_type=client_credentials` (form-urlencoded) |
| **Optional body field** | `scope=<space-separated-scope-list>` — omit to receive the token with the union of permitted scopes |
| **Modes** | M, I, MP |
| **TTL** | `expires_in: 3600` (1 hour) — no refresh_token |
| **Response** | `{ "access_token": "...", "token_type": "Bearer", "expires_in": 3600, "scope": "..." }` |
| **Plugin usage** | Cached in-process; refresh ~5 min before expiry. On 401 from any OAuth2 endpoint: force-refresh once, retry once. Multi-worker deployments inject a Redis lock for refresh coordination. |
| **Spec ref** | `oauth2-authentication.txt:70` |

### 1.2 Scopes

See `docs/AUTH.md` §4 for the full scope table. Plugin-relevant scopes:

| Scope | Used for |
|---|---|
| `urn:viva:payments:core:api:redirectcheckout` | Smart Checkout (M + MP) |
| `urn:viva:payments:core:api:isv` | ISV-specific endpoints (I) |
| `urn:viva:payments:core:api:acquiring` + `:acquiring:transactions` | Fast Refund + pre-auth |
| `urn:viva:payments:core:api:platform` | Marketplace platform (MP — reserved) |

---

## 2. Smart Checkout — create order

The plugin's primary call. Returns an `orderCode` used to construct the customer-facing Smart Checkout redirect URL.

### 2.1 Merchant mode

```
POST https://{oauth-api}/checkout/v2/orders
```

| | |
|---|---|
| **Auth** | OAuth2 — `redirectcheckout` scope |
| **Modes** | M |
| **Body (essential fields)** | `amount` (minor units), `currencyCode` (ISO 4217 numeric), `sourceCode` (string, default `"Default"`), `customerTrns` (text shown to customer), `merchantTrns` (private merchant text), `customer: { email, fullName, phone, countryCode, requestLang }`, `paymentTimeout` (seconds, default `1800`), `preauth` (bool, default `false` — plugin uses immediate-capture), `allowRecurring` (bool), `disableExactAmount`, `disableCash`, `disableWallet`, `maxInstallments`, `paymentMethodFees: [{paymentMethodId, fee}]`, `cardTokens: [string]`, `urlFail` (per-order failure URL override) |
| **Response 200** | `{ "orderCode": <number> }` — 16-digit numeric. Customer redirect URL is constructed as `https://{basic-api}/web/checkout?ref={orderCode}&color={hexNoHash}` |
| **Idempotency** | Plugin sends `Idempotency-Key` header but Viva does **not** dedupe server-side (probe F2 2026-04-25). Local `viva_transaction` row is authoritative. |
| **Spec ref** | `payment-api.yaml:6178` |

### 2.2 ISV mode

```
POST https://{oauth-api}/checkout/v2/isv/orders?merchantId={uuid}
```

| | |
|---|---|
| **Auth** | OAuth2 — `isv redirectcheckout` scopes |
| **Modes** | I |
| **Query** | `merchantId={uuid}` (connected merchant's UUID — required) |
| **Body** | Same as merchant + `isvAmount` (integer, minor units; ISV partner fee; **must be `< amount`**) |
| **Response** | Same as merchant |
| **Plugin guard** | If `resolveIsvAmount(order, ctx) >= order.amount`, throw `VIVA_ISV_AMOUNT_TOO_HIGH` before calling Viva. |
| **Spec ref** | `payment-isv-api.yaml:305` |

### 2.3 Marketplace mode *(reserved — not shipped in v0.2.x)*

```
POST https://{oauth-api}/checkout/v2/orders/    (note trailing slash)
```

| | |
|---|---|
| **Auth** | OAuth2 — five scopes (`acquiring acquiring:cardtokenization acquiring:transactions platform redirectcheckout`) |
| **Body addition** | `transfer: { amount, platformFee, connectedAccountId }` |
| **Spec ref** | `payment-api.yaml:4337` |

---

## 3. Transactions — retrieve / cancel

### 3.1 Retrieve transaction (merchant)

```
GET https://{oauth-api}/checkout/v2/transactions/{transactionId}
```

| | |
|---|---|
| **Auth** | OAuth2 — `redirectcheckout` scope |
| **Modes** | M |
| **Response fields (plugin uses)** | `statusId` (`'F'`=Finished/captured, `'A'`=Authorized, `'X'`=Cancelled, `'E'`=Error), `amount`, `currencyCode`, `merchantId`, `orderCode`, `transactionTypeId`, `cardNumber` (masked), `cardType` (`Visa`/`MasterCard`/...), `cardCountryCode`, `cardIssuingBank`, `customerTrns`, `merchantTrns`, `tipAmount`, `insDate` (ISO datetime), `loyaltyTransactionId`, `tags` |
| **Plugin usage** | Called from the webhook job handler **after** receiving 1796/1798 — "retrieve before settle" pattern. Validates amount against `viva_transaction.amount_minor` (`VIVA_AMOUNT_MISMATCH` if diverges). |
| **Spec ref** | `payment-api.yaml:6700` |

### 3.2 Retrieve transaction (ISV)

```
GET https://{oauth-api}/checkout/v2/isv/transactions/{transactionId}?merchantId={uuid}
```

| | |
|---|---|
| **Auth** | OAuth2 — `isv redirectcheckout` |
| **Modes** | I |
| **Query** | `merchantId={uuid}` |
| **Response** | Same fields as merchant retrieve |
| **Spec ref** | `payment-isv-api.yaml:1054` |

### 3.3 Cancel order (void unpaid auth)

```
DELETE https://{legacy-host}/api/orders/{orderCode}
```

| | |
|---|---|
| **Auth** | **Basic** — Merchant Basic `base64(MerchantId:ApiKey)` (M) / Reseller 3-part `base64(ResellerId:ConnectedMerchantId:ResellerApiKey)` (I) |
| **Host** | **Legacy host** (`demo.vivapayments.com` / `www.vivapayments.com`) — NOT the OAuth2 API host |
| **Modes** | M, I |
| **Effect** | Voids an unpaid Smart Checkout order (storefront `?paymentCancelled=1` flow). Idempotent — re-cancel returns `200 { Success: true }`. |
| **Plugin usage** | Called from Vendure `cancelPayment` Shop API mutation and from Medusa equivalent. Does NOT refund an already-paid transaction — use §4 for that. |
| **Note** | The OAuth2 route `DELETE /checkout/v2/orders/{orderCode}` does **not** exist — it returns an empty `404` for every order (verified live, 2026-06-13). Cancel lives only on the legacy host with Basic auth, exactly like the Cancel-transaction refund (§4.2). See `docs/internal/viva-cancel-probes/`. |

---

## 4. Refunds

Two paths. Plugin's `refundStrategy` config picks per call (default `'auto'`).

### 4.1 Fast Refund (OAuth2, modern, near-real-time)

```
POST https://{oauth-api}/acquiring/v1/transactions/{transactionId}:fastrefund
```

| | |
|---|---|
| **Auth** | OAuth2 — `acquiring acquiring:transactions` scopes |
| **Modes** | M, I |
| **Body** | `{ amount, sourceCode, merchantTrns, idempotencyKey }` (all required) |
| **Response 200** | `{ "transactionId": "<uuid>", "eventId": <number>, "amount": <number> }` |
| **Eligibility** | Visa or Mastercard (incl. Maestro); card-not-present (e-commerce); merchant approved by Viva sales for Fast Refund. Excludes betting merchants, POS, APMs. |
| **Status codes** | `200` success, `400` bad request, `403` not eligible, `404` original tx not found, `422` BIN invalid, `423` already in progress (idempotency-key conflict), `452` insufficient funds |
| **Webhook trigger** | 1797 (Transaction Reversal Created) with `EventData.ServiceId = 19` |
| **Cancellation** | Same-day, via `DELETE /acquiring/v1/transactions/{transactionId}` — not implemented in v0.2.x |
| **Spec ref** | `payment-api.yaml:9255` |

### 4.2 Standard refund — Viva "Cancel transaction" (Basic, universal)

```
DELETE https://{basic-api}/api/transactions/{transactionId}?amount=<minor>&sourceCode=<code>&currencyCode=<iso4217>
```

| | |
|---|---|
| **Method** | `DELETE` — NOT POST. (POST `/api/transactions/{id}` is pre-auth **capture**, a different operation.) |
| **Auth (merchant mode)** | Basic — Merchant variant (`MerchantId:ApiKey`) |
| **Auth (ISV mode)** | Basic — **Reseller** variant (`base64(ResellerId:ConnectedMerchantId:ResellerApiKey)`). The Reseller ID/Key are **Viva-issued** (demo and production pairs differ), distinct from dashboard ISV credentials. |
| **Modes** | M, I |
| **Params** | Query string (no body): `amount` (minor units; omit for full refund), `sourceCode` (optional, defaults `Default`), `currencyCode` (optional, ISO 4217 numeric). |
| **Response 200** | `{ "TransactionId": "<uuid>", "StatusId": "F", "Amount": <number> }` (PascalCase). Success = `StatusId === 'F'`. |
| **Eligibility** | All cards / all payment methods / all merchants — universally available |
| **Settlement** | T+2 settlement window (slower than Fast Refund) |
| **Webhook trigger** | 1797 (Transaction Reversal Created) — `EventData.ServiceId` ≠ 19. ISV fee reverses automatically. |
| **Spec ref** | `payment-api.yaml:8592`, `payment-isv-api.yaml:2640` (auth structure `:2650`) |

### 4.3 Refund strategy in the plugin

```
if refundStrategy == 'fast' OR (refundStrategy == 'auto' AND eligible):
    try Fast Refund
    on 403 → fall back to Standard refund (if strategy == 'auto')
else:
    Standard refund
```

Eligibility check: read `cardType` from §3.1 retrieve-transaction response → `Visa` | `MasterCard` → eligible. Other schemes → ineligible.

---

## 5. Payment Sources

Source codes group transactions for reporting and enable channel-specific theming. New ISV-mode capability in v0.2.x.

### 5.1 Create source

```
POST https://{basic-api}/api/sources
```

| | |
|---|---|
| **Auth (merchant mode)** | Basic — Merchant variant (`MerchantId:ApiKey`) |
| **Auth (ISV mode, for connected merchant)** | Basic — **Reseller variant** (`ResellerId:ConnectedMerchantId` / `ResellerApiKey`) |
| **Modes** | M, I |
| **Body (e-commerce)** | `{ "domain": "www.example.com", "isSecure": true, "name": "Storefront", "pathFail": "fail", "pathSuccess": "success", "sourceCode": 1234 }` |
| **Body (physical)** | `{ "isPhysical": true, "name": "Store 1", "sourceCode": 1234 }` |
| **Constraint** | If `isPhysical` is not `true`, then `domain`, `pathFail`, `pathSuccess` are required |
| **Response** | Source object with the assigned `sourceCode` (4-digit; auto-assigned if not in request) |
| **Plugin usage** | Optional admin REST endpoint `POST /viva/admin/connected-accounts/:id/sources` in ISV mode (requires `reseller` config; else 412). Not surfaced in merchant mode by default — operators create sources manually in Self Care. |
| **Spec ref** | `payment-isv-api.yaml:135`, `payment-api.yaml:9574` |

---

## 6. ISV — Connected Accounts

ISV-only. Used during shop onboarding under an ISV partner.

### 6.1 Create connected account

```
POST https://{oauth-api}/isv/v1/accounts
```

| | |
|---|---|
| **Auth** | OAuth2 — `isv redirectcheckout` |
| **Modes** | I |
| **Body** | `{ "email": "merchant@example.com", "returnUrl": "https://your-saas.com/onboarding/return", "branding": { "partnerName": "...", "primaryColor": "...", "logoUrl": "..." } }` |
| **Response 200** | `{ "accountId": "<uuid>", "invitation": { "email": "...", "redirectUrl": "https://demo-app.vivapayments.com/register/invite/3/<accountId>", "created": "<iso>" } }` |
| **Plugin usage** | Admin REST `POST /viva/admin/connected-accounts`. Plugin stores `accountId` on the channel (Vendure) / store (Medusa). |
| **Probe note** | 2026-05-11: confirmed working. Returned `accountId`, no `merchantId` yet (merchantId arrives after KYC via webhook 8194). |
| **Spec ref** | `payment-isv-api.yaml:3790` |

### 6.2 Get connected account

```
GET https://{oauth-api}/isv/v1/accounts/{accountId}
```

| | |
|---|---|
| **Auth** | OAuth2 — `isv redirectcheckout` |
| **Modes** | I |
| **Response 200** | `{ "accountId": "<uuid>", "email": "...", "verified": <bool>, "merchantId": "<uuid> \| null", "taxNumber": "...", "vatNumber": "...", "legalName": "...", "acquiringEnabled": <bool>, "registrationNumber": "...", "created": "<iso>", "invitation": { ... } }` |
| **Plugin usage** | Admin REST `GET /viva/admin/connected-accounts/:channelId`. Also called from the reconcile endpoint to recover from a missed 8194 webhook. |
| **Probe note** | 2026-05-11: returns the account record; `verified: false` and `merchantId: null` until the merchant completes KYC at the invitation `redirectUrl`. |
| **Spec ref** | `payment-isv-api.yaml:3938` |

### 6.3 Not exposed by Viva (and not in the plugin)

- **No `PATCH /isv/v1/accounts/{id}`** in the spec — accounts are immutable post-creation; corrections must go through Viva support.
- **No list endpoint** — the SaaS owns the list (one `accountId` per channel/store).
- **No `DELETE`** — disconnection is manual through Viva.

---

## 7. ISV — Webhook registration

ISV mode registers webhooks at the **partner level** — one URL per event type covers all connected merchants under the ISV.

### 7.1 Generate verification key

```
GET https://{oauth-api}/isv/v1/webhooks/token
```

| | |
|---|---|
| **Auth** | OAuth2 — `isv redirectcheckout` |
| **Modes** | I |
| **Response 200** | `{ "key": "<verification-key>" }` |
| **Plugin usage** | Called by `vendure-viva-register-webhooks --apply` / `viva-register-webhooks --apply`. The key is stored in `VIVA_WEBHOOK_VERIFICATION_KEY` and returned to Viva on every `GET /viva/webhook` URL-verify probe. Do **not** rotate without re-registering. |
| **Note** | "No Merchant ID/API Key should be used when setting up webhooks on the ISV level" (per ISV yaml description). |
| **Spec ref** | `payment-isv-api.yaml:4062` |

### 7.2 Register webhook URL

```
POST https://{oauth-api}/isv/v1/webhooks
```

| | |
|---|---|
| **Auth** | OAuth2 — `isv redirectcheckout` |
| **Modes** | I |
| **Body** | `{ "url": "https://your-saas.com/viva/webhook", "eventTypeId": <event-id> }` |
| **Event IDs typically registered** | `1796`, `1797`, `1798`, `4865`, `8193`, `8194` (also `1802`, `1803` for POS-ECR if applicable) |
| **Behavior** | Viva probes the URL with `GET ?key=...` and expects `{"key": "<same-key-from-§7.1>"}` in the response — that's the verification handshake (no HMAC). |
| **Idempotency** | Re-registering the same `(url, eventTypeId)` either succeeds-as-no-op or returns a duplicate error — plugin's `--reconcile-drift` reads existing subscriptions and reconciles. |
| **Plugin usage** | One call per event type. CLI orchestrates the loop. |
| **Spec ref** | `payment-isv-api.yaml:4166` |

### 7.3 Not in the spec (verify via probe if needed)

- No `GET /isv/v1/webhooks` (list registrations) is documented in the yaml — plugin's `--reconcile-drift` flag may need to maintain a local registry instead of querying. **Q for first probe.**
- No `DELETE /isv/v1/webhooks/{id}` — to remove a URL, current best-effort is to re-register with a different URL or contact Viva. **Q for first probe.**

---

## 8. Merchant — Webhook helper

Merchant + marketplace modes don't have a webhook registration API for payment events — the operator pastes the URL into Self Care UI. The only API call needed is to fetch the URL-verify key.

### 8.1 Get webhook verification key

```
GET https://{basic-api}/api/messages/config/token
```

| | |
|---|---|
| **Auth** | Basic — Merchant variant (`MerchantId:ApiKey`) |
| **Modes** | M, MP |
| **Response** | `{ "Key": "<verification-key>" }` (exact field name unverified — plugin tolerates both `key` and `Key`) |
| **Plugin usage** | Called by `viva-register-webhooks --apply` in merchant mode. Prints the key + URLs the operator must paste into Self Care → Sales → API Access → Webhooks. |
| **Note** | Single key per merchant — covers all events that merchant subscribes to. |
| **Spec ref** | `webhooks-for-payments.txt:311` (text doc; not in OpenAPI yaml) |
| **Probe Q** | Phase 5 smoke must confirm response shape (exact key name, content-type). |

### 8.2 Bulk webhook subscriptions (separate API — NOT for payment events)

```
POST https://{oauth-api}/dataservices/v1/webhooks/subscriptions
```

| | |
|---|---|
| **Auth** | OAuth2 — `urn:viva:payments:biservices:datafileapi` |
| **Available events** | **Only `SaleTransactionsFileGenerated`** — does NOT register 1796/1797/1798/4865 |
| **Plugin usage** | Not used. Mentioned only to disambiguate — this is the wrong endpoint for payment-event registration. |
| **Spec ref** | `payment-api.yaml:608` |

---

## 9. Marketplace — Platform endpoints *(reserved)*

Not implemented in v0.2.x. Listed for completeness and to anchor the marketplace seam reservations in `multi-mode-v0.md` §7.

### 9.1 Create connected account (marketplace)

```
POST https://{oauth-api}/platforms/v1/accounts
```

| | |
|---|---|
| **Auth** | OAuth2 — `acquiring acquiring:cardtokenization acquiring:transactions platform redirectcheckout` |
| **Body (essential)** | `email`, `mobile`, `legalName`, `tradeName`, `taxNumber`, `returnUrl`, `address: {...}`, `branding: {...}`, `payouts: { statementDescriptor, dayOfWeek, dayOfMonth, interval, amountThreshold, disable, bankAccount: {...} }` |
| **Spec ref** | `payment-api.yaml:3491` |

### 9.2 Get / update connected account

```
GET   https://{oauth-api}/platforms/v1/accounts/{accountId}
PATCH https://{oauth-api}/platforms/v1/accounts/{accountId}
```

| **Spec ref** | `payment-api.yaml:3729` |

### 9.3 Transfers

```
POST https://{oauth-api}/platforms/v1/transfers
```

Manual transfers between connected accounts and platform wallets. The marketplace Smart Checkout flow (§2.3) auto-creates transfers based on the `transfer` body field — explicit transfers are for ad-hoc rebalancing.

| **Spec ref** | `payment-api.yaml:4037` |

---

## 10. Incoming webhook events

Endpoints above are *outbound* (plugin → Viva). Below is the *inbound* surface — Viva → plugin webhook receiver. The plugin's `POST /viva/webhook` accepts all events.

### 10.1 Event-type catalogue (plugin-relevant)

| EventTypeId | Name | Modes | Handler behaviour |
|---|---|---|---|
| **1796** | Transaction Payment Created | M, I, MP | Trigger settle flow (retrieve → validate amount → transition payment to `Settled`) |
| **1797** | Transaction Reversal Created | M, I, MP | Mark `viva_transaction.status='refunded'`. `EventData.ServiceId = 19` indicates Fast Refund. |
| **1798** | Transaction Payment Failed | M, I, MP | Mark `viva_transaction.status='failed'`. Non-terminal — order stays in `ArrangingPayment` for retry. |
| **1799** | Transaction Price Calculated | M, I | Informational. Not handled. |
| **2054** | Account Transaction | M | Informational. Not handled. |
| **4865** | Order Updated | M, I, MP | `StatusId ∈ {X, C, E}` indicates user cancellation. Plugin maps to cancellation; the exact lettered status for user-cancel is still TBD (resume note). |
| **8193** | Account Connected | I, MP | Log only. Not action-required for the plugin. |
| **8194** | Account Verification Status Changed | I, MP | ISV mode: write `vivaMerchantId` to channel/store custom fields, then flip `vivaPayoutsEnabled=true`. Field-write order is mandatory (see Vendure README §Field-Write Order). |
| **8448** | Transfer Created | MP | Reserved for marketplace mode. Not handled in v0.2.x. |
| **1802 / 1803** | POS-ECR Session Created / Failed | (out of scope) | Not handled — plugin is e-commerce only. |
| **5632 / 5633** | Obligation events (deprecated) | — | Not handled. |

### 10.2 Webhook envelope shape

All events arrive as `POST /viva/webhook` with body:

```json
{
  "Url": "https://your-saas.com/viva/webhook",
  "EventData": { /* event-specific payload */ },
  "Created": "2026-05-12T10:01:23.456Z",
  "CorrelationId": "<id>",
  "EventTypeId": 1796,
  "Delay": null,
  "MessageId": "<uuid>",       // dedupe key
  "RecipientId": "<uuid>",
  "MessageTypeId": 0
}
```

Dedupe by `MessageId` only (NOT `EventData.TransactionId` — replays carry the same `MessageId` but distinct events on the same transaction must be processed).

### 10.3 URL-verify handshake (GET)

```
GET https://your-saas.com/viva/webhook?key=...
```

Plugin returns `200 { "Key": "<verification-key>" }` from the relevant key (§7.1 for ISV, §8.1 for merchant/marketplace). Used by Viva during webhook registration AND on periodic re-verification.

### 10.4 Auth on incoming webhook

- **No HMAC, no body signing.**
- Plugin authenticates via:
  1. **IP allowlist** — Viva's published CIDRs (different for demo + prod; plugin's default list is the union).
  2. **URL-verify key** — only Viva knows it; the plugin returns it on GET.

---

## 11. Deprecated endpoints

Listed for completeness. Plugin does not call any of these.

| Endpoint | Replacement | Spec ref |
|---|---|---|
| `POST /api/orders` (Basic, merchant) | `POST /checkout/v2/orders` (OAuth2) | `payment-api.yaml:7214` |
| `POST /api/bankaccounts`, `GET /api/bankaccounts/{id}` | `/banktransfers/v1/bankaccounts` (OAuth2) | `payment-api.yaml:5300`, `:5910` |
| `POST /api/wallets/{walletId}/commands/banktransfer/{bankAccountId}` | banktransfers OAuth2 | `payment-api.yaml:5738` |
| `GET /api/wallets` | `GET /merchants/v1/wallets` (OAuth2) | `payment-api.yaml:7628` |
| `DELETE /api/transactions/{transaction_id}` "Pay Out (OLD)" (ISV) | Contact Viva sales | `payment-isv-api.yaml:2807` |

The Basic-auth surface (`{basic-api}`) is NOT deprecated as a whole — see `docs/AUTH.md` §2. Only these specific endpoints within it are.

---

## 12. Quick lookup by task

| I want to … | Use endpoint | Modes |
|---|---|---|
| Get an OAuth2 token | §1.1 `POST /connect/token` | M, I, MP |
| Start a Smart Checkout (single merchant) | §2.1 `POST /checkout/v2/orders` | M |
| Start a Smart Checkout (per-tenant under ISV) | §2.2 `POST /checkout/v2/isv/orders?merchantId=...` | I |
| Read what happened with a transaction | §3.1 / §3.2 | M / I |
| Cancel an unpaid order (user clicked Back) | §3.3 | M, I |
| Refund a captured payment (preferred) | §4.1 Fast Refund | M, I (if eligible) |
| Refund a captured payment (universal) | §4.2 Standard refund | M, I |
| Create a source code for a connected merchant | §5.1 with Reseller Basic | I |
| Onboard a new merchant under ISV | §6.1, send invitation URL | I |
| Check onboarding/verification status | §6.2 | I |
| Register webhook URLs at the ISV level | §7.1 → §7.2 (loop per event) | I |
| Fetch webhook verification key (merchant) | §8.1, then paste URL in Self Care | M, MP |
| Handle 1796 payment-created event | §10.1, §10.2 | M, I, MP |
| Handle 8194 verification event | §10.1 (ISV-only handler) | I |

---

## 13. Probe-verified findings

Findings from `scripts/viva-isv-probe-findings.md` (2026-05-11) and prior probes. Worth re-validating during Phase 5 of `multi-mode-v0.md`.

| # | Date | Finding | Impact |
|---|---|---|---|
| F1 | 2026-04-25 | `POST /checkout/v2/transactions/{id}` (OAuth2) returns **405** — there is no OAuth2 refund on that path | §4.2 Standard refund must use the Basic-auth `/api/transactions/{id}` path |
| F2 | 2026-04-25 | `Idempotency-Key` header NOT honoured server-side on `POST /checkout/v2/isv/orders` (same key → different orderCodes) | Plugin's local `viva_transaction` row is authoritative for dedup |
| F3 | 2026-05-11 | Token requested with no `scope` param returns the union of all permitted scopes for the client | Plugin still requests scopes explicitly — defensive |
| F4 | 2026-05-11 | Canonical ISV paths confirmed: `/isv/v1/accounts`, `/isv/v1/webhooks`, `/isv/v1/webhooks/token` (older `/api/isv/...` variants return 404 or 405) | Plugin code aligned |
| F5 | 2026-05-11 | `POST /isv/v1/accounts` returns `redirectUrl` on `demo-app.vivapayments.com` for invitations | Onboarding flow surfaces this URL to the shop principal |

Open Q (resolve at first probe):
- Q1: List/delete endpoints under `/isv/v1/webhooks` — exist? Plugin's `--reconcile-drift` depends on this.
- Q2: `GET /api/messages/config/token` response shape — `key` vs `Key`, content-type, key rotation rules.
- Q3: 4865 `StatusId` letter for user-cancel (still `TODO(impl)` in process-viva-webhook handler).
- Q4: Production webhook source IP CIDRs — current default vs Viva's actual.

---

## 14. References

- [`docs/AUTH.md`](./AUTH.md) — auth schemes (Basic vs OAuth2), scopes, hosts matrix
- `references/viva-docs/md/webhooks-for-payments.txt` — event type catalogue
- `references/viva-docs/md/wh-transaction-payment-created.txt`, `wh-transaction-failed.txt`, `wh-account-connected.txt`, `wh-account-verif-status-changed.txt`, `wh-sale-transactions.txt` — per-event payload references
- `references/viva-docs/md/isv-partner-program.txt`, `isv-credentials.txt` — ISV onboarding + credentials
- `references/viva-docs/md/oauth2-authentication.txt` — token endpoint detail
- `references/viva-docs/md/merchant-id-and-api-key.txt`, `find-account-credentials.txt` — credential lookup paths
- `scripts/viva-isv-probe-findings.md` — 2026-05-11 sandbox probe report
- `scripts/viva-sandbox-probe.ts`, `viva-isv-probe.ts`, `viva-refund-probe.ts` — probe sources

---

## 15. Changelog (this document)

- 2026-05-12 — initial. Canonical endpoint matrix grounded in `payment-api.yaml` + `payment-isv-api.yaml`. Covers merchant / ISV / marketplace (reserved). Includes Fast Refund (modern OAuth2) alongside Standard refund (Basic). Probe findings F1–F5 captured. Marketplace endpoints listed but not implemented in v0.2.x.
