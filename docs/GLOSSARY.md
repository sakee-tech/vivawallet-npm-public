# Viva Wallet Plugin — Glossary

> Terms that get confused. Read this when a code review or ticket comment mixes them up.

---

## IDs that look alike

Each row is a distinct UUID/string. Don't mix them.

| Term | Issued by | Lives where | Used for | Example shape |
|---|---|---|---|---|
| **`orderCode`** | Viva (returned from `POST /checkout/v2/orders`) | `viva_transaction.order_code` | Constructing the Smart Checkout redirect URL (`?ref={orderCode}`); cancel order URL (`DELETE /checkout/v2/orders/{orderCode}`) | 16-digit numeric — `1234567890123456` |
| **`transactionId`** | Viva (created when customer pays) | `viva_transaction.viva_transaction_id`; arrives in webhook `EventData.TransactionId` | Retrieve transaction; refund; cancel rebate | UUID — `b1a3067c-321b-4ec6-bc9d-1778aef2a19d` |
| **`messageId`** | Viva (envelope field on every webhook) | `viva_webhook_event.message_id` (PK) | Webhook idempotency / dedupe | UUID |
| **`eventId`** | Viva (per-transaction internal ID, distinct from `messageId`) | `EventData.EventId` in webhook body; refund response body | Tracking Viva's internal event chain; correlating Fast Refund response with downstream 1797 | numeric / UUID depending on context |
| **`correlationId`** | Viva (envelope field) | webhook envelope `CorrelationId` | Support requests to Viva — quote this to their team | string |
| **`merchantId`** | Viva (one per merchant account; in ISV mode, one per connected merchant) | `viva_transaction.merchant_id`; Vendure `Channel.customFields.vivaMerchantId`; ISV mode env / per-call `?merchantId=` query | Scoping ISV API calls to a specific merchant; refund Basic-auth username | UUID |
| **`accountId`** | Viva (one per ISV-connected merchant, **before** verification — distinct from `merchantId`) | `Channel.customFields.vivaAccountId`; `POST /isv/v1/accounts` response | Tracking onboarding state. After verification, the same merchant has BOTH an `accountId` AND a `merchantId`. | UUID |
| **`sourceCode`** | Merchant (chosen at source creation; auto-assigned 4-digit if not specified) | `Channel.customFields.vivaSourceCode`; passed as `sourceCode` body field | Smart Checkout body `sourceCode`; refund body `SourceCode`; grouping transactions in Viva reports | 4-digit number as string — `"1234"` or named — `"Default"` |
| **`paymentId`** (Vendure) / **`payment.id`** (Medusa) | Storefront framework | Vendure `Payment` entity; Medusa `Payment` model | Storefront identity for cancel/refund mutations | `'pmt_xxx'` or numeric |
| **`paymentSessionId`** (Medusa) | Medusa | Medusa `PaymentSession` | Provider call routing; plugin's idempotency key for `createOrder` | string |

### Quick examples of mix-ups to avoid

- ❌ "Refund transaction `1234567890123456`" — that's an `orderCode`, not a `transactionId`. Refund needs the UUID `transactionId`.
- ❌ "Look up the account by `merchantId`" — in ISV mode, `merchantId` may not exist yet (pre-verification). Look up by `accountId`.
- ❌ "Dedupe webhooks by `transactionId`" — `MessageId` is the dedup key. Two events on the same transaction (1796 + 1798 retry) share `transactionId` but have distinct `messageId`.

---

## Auth credential terms

| Term | What it is | Where to find | Used for |
|---|---|---|---|
| **`client_id`** + **`client_secret`** | OAuth2 client_credentials pair | Self Care → API Access → Smart Checkout (merchant) or → ISV Partner (ISV) | Token issuance at `POST /connect/token` |
| **Merchant Basic** | `MerchantId:ApiKey` HTTP Basic credentials | Self Care → Settings → API Access → Merchant credentials | Standard refund, `/api/sources` in merchant mode, `/api/messages/config/token` |
| **Reseller Basic** | `ResellerId:MerchantId / ResellerApiKey` HTTP Basic credentials | Self Care → ISV Partner → Reseller credentials | `/api/sources` for ISV-connected merchants only |
| **`webhookVerificationKey`** | URL-verify response key (NOT a per-request signature) | Generated via `/isv/v1/webhooks/token` (ISV) or `/api/messages/config/token` (merchant) | Returned in body of every `GET /viva/webhook` URL-verify probe |
| **`adminToken`** | Plugin-internal bearer for `/viva/internal/*` endpoints | Operator sets via `VIVA_ADMIN_TOKEN` env | Gating internal monitoring endpoints |

---

## Plugin terms

| Term | Meaning |
|---|---|
| **mode** | Plugin operational mode: `'merchant'` (default, single tenant) \| `'isv'` (multi-tenant under ISV partnership) \| `'marketplace'` (reserved, not shipped in v0.2.x) |
| **handler** (Vendure) / **provider** (Medusa) | The `PaymentMethodHandler` / `AbstractPaymentProvider` implementation in the adapter package |
| **receiver** | The `POST /viva/webhook` HTTP controller that accepts incoming events |
| **worker** / **job** | BullMQ (Vendure) / async queue (Medusa) job that processes a single webhook event after dedupe |
| **`viva_transaction`** | Plugin DB table — one row per `(channelId, paymentId)`, owns the authoritative dedup state, amount, status, links to Viva IDs |
| **`viva_webhook_event`** | Plugin DB table — one row per `MessageId`, INSERT-OR-IGNORE for dedupe, tracks `processed_at` + `error` |
| **retrieve-before-settle** | Pattern: webhook arrives → fetch authoritative transaction state via `GET /checkout/v2/transactions/{id}` → only then transition the order |
| **stale-order re-walk** | Recovery path: order rolled back to `AddingItems` by a sweep but webhook is still being processed → handler re-transitions to `PaymentSettled` |
| **`isvAmount`** | ISV partner fee (minor units) on `POST /checkout/v2/isv/orders`. Must be `< amount` or Viva declines. |
| **`statusId`** | Viva transaction status letter from retrieve-transaction response. Letters: `F`=Finished/captured, `A`=Authorized, `X`=Cancelled, `E`=Error, `C`=Created (other letters TBD per probe). |
| **`EventTypeId`** | Numeric ID of webhook event type (e.g., `1796`=Transaction Payment Created). See `docs/ENDPOINTS.md` §10. |
| **field-write order** | Mandatory sequence in 8194 handler: write `vivaMerchantId` first, flip `vivaPayoutsEnabled=true` last. Reversing risks letting a `createPayment` call through with `merchantId=null`. |

---

## Viva product terms

| Term | What it actually is |
|---|---|
| **Smart Checkout** | Hosted (redirect) payment page at `*.vivapayments.com/web/checkout`. SAQ A — no card data on integrator. Plugin's only supported flow. |
| **Native Checkout v2** | JavaScript SDK for embedding card collection on the storefront. **Not** supported by this plugin (different PCI scope). |
| **Smart Checkout — preauth** | Authorization without immediate capture. `preauth: true` on createOrder. Plugin uses immediate-capture only (out of scope for v0.2.x). |
| **Fast Refund** | Modern OAuth2 refund — Visa/MC e-commerce only, near-real-time. Different endpoint from Standard refund. |
| **Standard refund** | Basic-auth refund — universal, T+2 settlement. |
| **Rebate** | Independent credit transaction (not tied to a refund of a specific payment). Not used by plugin. |
| **Pre-auth increase** | Incremental authorization — `/acquiring/v1/isv/transactions/{id}:increasepreauth`. ISV-only endpoint, not in plugin scope. |
| **Self Care** | Viva's web app at `members.vivawallet.com` (operator UI for credentials, source codes, manual webhook registration). |
| **ISV Partner program** | Viva's multi-tenant model — one platform account owns N connected merchants, with single platform-wide OAuth2 credentials. |
| **Connected account** | An ISV-onboarded merchant. Has an `accountId`; gets a `merchantId` after KYC. |
| **Reseller** | A specific role within the ISV Partner program — has its own Reseller ID/API Key used for source creation on connected merchants. |
| **Acquiring** | Viva's card-acquiring layer. Some scopes (`...:acquiring`, `...:acquiring:transactions`) gate access to acquiring-level operations. |
| **APM** | Alternative Payment Method (Klarna, Apple Pay, Google Pay, etc.). Smart Checkout supports many APMs; not all support Fast Refund (Visa/MC only). |

---

## Environment / host terms

See `docs/AUTH.md` §9 for the full hosts matrix. Quick disambiguation:

| Host | Family | Notes |
|---|---|---|
| `accounts.vivapayments.com` | OAuth2 **token** issuance | `/connect/token` lives here |
| `api.vivapayments.com` | OAuth2 **API** | Modern endpoints — checkout, isv, acquiring, platforms |
| `www.vivapayments.com` | **Basic-auth** API | `/api/transactions/{id}` (refund), `/api/sources`, `/api/messages/config/token`. NOT the same host as `api.*`. |
| `app.vivapayments.com` | Customer-facing app | Onboarding redirects (ISV invitation URLs) land here |
| `members.vivawallet.com` | Self Care UI | Operator login |
| `developer.viva.com` | Developer portal (docs) | Rebranded primary; `developer.vivawallet.com` aliases it |

Demo variants: prefix `demo-` for `accounts`, `api`, `app`; replace `www` with `demo` (so `demo.vivapayments.com`).

---

## "Legacy" — what it does and doesn't mean

- **Does mean** in the plugin code: "the Basic-auth surface at `www.vivapayments.com` / `demo.vivapayments.com`" (`LegacyBasicClient`).
- **Does NOT mean** "deprecated by Viva." Viva's Basic-auth surface is current — only specific endpoints inside it are deprecated (`docs/ENDPOINTS.md` §11).
- **v0.2.0 rename**: `LegacyBasicClient` → `BasicAuthClient`. Same code, more honest name.

---

## References

- [`docs/AUTH.md`](./AUTH.md) — auth schemes + hosts
- [`docs/ENDPOINTS.md`](./ENDPOINTS.md) — endpoint matrix
- [`docs/ERRORS.md`](./ERRORS.md) — error code catalogue
