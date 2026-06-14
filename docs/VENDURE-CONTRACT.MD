**Source:** `/plan-eng-review` 2026-04-25 on `retail-commerce` (interior-pages-redesign).
**Audience:** the Viva Vendure plugin you are building (separate repo from retail-commerce).
**Purpose:** capture the storefront-side decisions and ISV API constraints so the plugin's API surface lines up with both before you start building.

This is an **input** to your plugin design. Each section is "the storefront expects this; tell me if your plugin does it differently and we'll adjust the storefront."

**Scope:** retail-commerce uses the **Viva ISV Partner Program** with Smart Checkout — ISV is the commercial/credentialing layer, Smart Checkout is the payment UX. The plugin must support multi-merchant operation from day one. Viva is **the only payment option** for this platform — Stripe is out due to its acceptable-use policy on tobacco/alcohol; there is no fallback. See `docs/architecture/viva-isv-reference.md` (in retail-commerce) for the full ISV API ground-truth fetched from Viva's published OpenAPI spec and reference material.

**Status:** all v0 open questions resolved 2026-04-25. Webhook + economics mechanics confirmed from official Viva docs (see `../references/viva-docs/md/`). Five smaller items remain open for the Viva ISV discovery call (`docs/RESUME.md` §1) — see §13.

---

## 1. The redirect contract (storefront → plugin)

When the storefront's checkout sheet calls `addPaymentToOrder`, it expects:

```graphql
mutation {
  addPaymentToOrder(input: { method: "viva", metadata: {} }) {
    ... on Order {
      payments {
        id
        state                # 'Created' (see §2)
        metadata             # { redirectUrl: 'https://...vivapayments.com/web/checkout?ref=...' }
      }
    }
  }
}
```

The storefront reads `payments[last].metadata.redirectUrl` and runs `window.location.href = redirectUrl`. **No additional GraphQL roundtrip.** No "create checkout URL" custom mutation. The Vendure-canonical `addPaymentToOrder` is the only call.

**Plugin design notes:**
- `PaymentMethodHandler.createPayment` calls Viva's ISV variant: `POST /checkout/v2/isv/orders?merchantId={uuid}` — with the active Channel's `merchantId` resolved from a custom field (see §7).
- The response is `{"orderCode": <12-digit number>}` — **only the `orderCode`, no redirect URL.** Plugin constructs the redirect URL itself:
  - Live: `https://www.vivapayments.com/web/checkout?ref={orderCode}`
  - Demo: `https://demo.vivapayments.com/web/checkout?ref={orderCode}`
  - Optional `&color={hexCode}` for theming.
- Plugin returns the constructed URL to Vendure as `payment.metadata.redirectUrl`. The storefront blindly uses it.
- Auth: OAuth2 client_credentials, scopes `urn:viva:payments:core:api:isv` + `urn:viva:payments:core:api:redirectcheckout`. Token lifetime is 3600s with no refresh_token — re-issue via `client_credentials`. Cache the bearer; refresh ~5min before expiry. **Same client_id / client_secret pair covers both demo and live;** the `environment` flag in plugin config switches the host only.
- The handler runs synchronously inside `addPaymentToOrder`. **Latency budget: <1.5s end-to-end** including the Viva API call.
- On Viva API errors (5xx, timeout), throw — Vendure transitions the order back from `ArrangingPayment` and the storefront shows an error banner per locked decision A1.

---

## 2. Authorized vs Created — RESOLVED: Option β (Created)

**Decision:** plugin marks Payment `Created` in `createPayment` and waits for Viva's `Transaction Payment Created` webhook (EventTypeId 1796) — the definitive server-to-server signal — before transitioning. State reflects "sent to Viva, no result yet" until the webhook drives Created → Authorized → Settled. The redirect-back query params (`t=`, `s=`) are used only for navigation, not state.

**Success-return resolution (#28):** the ISV redirect lands on the source's success/fail URL carrying only `?s=<vivaOrderCode>` and `?t=<transactionId>` — neither is the Vendure order code, so the storefront has no first-party way to turn the return into an order for the confirmation page. The plugin exposes a Shop-API query `orderByVivaReturn(vivaOrderCode: String!): Order` that does the one indexed join it alone owns — `viva_transaction.vivaOrderCode` (unique index) → `paymentId` → `Payment` → `Order` — with no ISV API call. It is owner-scoped exactly like `cancelPayment` (§3) and returns `null` when the code is unknown or not owned by the caller, so `?s=` can't be enumerated to leak orders. This removes the fragile cross-site cookie storefronts previously used to bridge the return (Safari/iOS ITP drops it).

**Why:** Viva's documented pattern is "always retrieve transaction details from Viva before acting on a webhook" (`webhooks-for-payments.txt:248`). The webhook is the trigger; the Retrieve Transaction API is truth. Mirroring Stripe's optimistic-Authorized convention would set state without verifying.

---

## 3. Cancel ownership — RESOLVED: plugin owns cancel

**Decision:** the plugin owns rollback. It exposes a single `cancelPayment(paymentId)` mutation that voids the Viva-side authorization AND transitions the Vendure order back to `AddingItems`. The storefront calls only that mutation on `?paymentCancelled=1`.

**Consequence for storefront's locked A1:** the `cancelArrangingPayment` server action shipped in commit `c3442d1` becomes a thin wrapper that delegates to `cancelPayment`. When the plugin lands (Phase B), drop the local `transitionOrderToState('AddingItems')` call — the plugin already handles it. Until then, the server action acts as a bridge.

---

## 4. Webhook receiver — RESOLVED + several constraints from Viva docs

### Idempotency

**Decision:** plugin maintains a `viva_webhook_event` table keyed by **`MessageId`** (top-level envelope UUID), NOT `TransactionId`. Reason: Viva retries deliveries with the same `MessageId` (`wh-transaction-payment-created.txt:253–258`). Using `TransactionId` would silently discard replays before checking `RetryCount`.

Schema: `(MessageId UUID PRIMARY KEY, MerchantId UUID, TransactionId string, EventTypeId int, ReceivedAt timestamp, ProcessedAt timestamp NULL, Payload JSON)`. INSERT-OR-IGNORE on receipt; only process if newly inserted.

### Webhook authentication — IP allowlist + URL-verification handshake

Viva does **not** sign webhook POST bodies. There is no HMAC, no `X-Webhook-Signature`, no `Authorization` header on inbound webhooks. The documented mechanisms (`webhooks-for-payments.txt:270–363`):

1. **IP allowlist** — Viva publishes the source IPs; the plugin's webhook endpoint should reject anything else.
2. **URL-verification key handshake at registration** — when registering the webhook URL, Viva GETs the endpoint and expects `{"key": "<verification-key>"}` back. In ISV mode this key is **Viva-issued** (one per ISV account, fetched via `GET /isv/v1/webhooks/token`), not plugin-generated: the `register-webhooks` CLI fetches it and reconciles it against `VIVA_WEBHOOK_VERIFICATION_KEY`, aborting loudly on mismatch rather than inventing a value. In merchant mode the key is operator-chosen via Self-Care (`GET /api/messages/config/token`). It's a per-account secret, not a per-request secret.

The contract's previous `webhookSecret` config field has no Viva counterpart and should be replaced with `webhookVerificationKey`.

### Payload schema notes

- Top-level envelope: `MessageId` (UUID), `EventTypeId` (int), `CorrelationId` (string), `RetryCount` (int), `RetryDelayInSeconds` (int).
- `EventData.MerchantId` (UUID) is present on both `Transaction Payment Created` (1796) and `Transaction Failed` (1798) — confirmed at `wh-transaction-payment-created.txt:175,382` and `wh-transaction-failed.txt:179`. This is the per-merchant routing key.
- `EventData.ConnectedAccountId` exists but is `null` in sample payloads. Don't rely on it as primary; treat it as supplementary.
- `EventData.CurrencyCode` is a **string** in webhook payloads (`"978"`, `"826"`), not an integer. Don't `parseInt` without checking.
- `EventData.OrderCode` (12-digit numeric) ties the event back to the Vendure payment record.

### Retry policy

24 deliveries (1 initial + 23 retries), one per hour (`webhooks-for-payments.txt:133`, `RetryDelayInSeconds: 3600`). Max 24h exposure window before the event is permanently dropped. After that, recovery falls to the stale-order sweep + Retrieve Transaction API.

### Settle path

**MUST call Retrieve Transaction before settling.** Verbatim from `webhooks-for-payments.txt:248–252`:

> you SHOULD always retrieve its details from Viva. Use the `transactionId` in the payload and make a call to the Retrieve Transaction API. Validate the `orderCode`, `statusId` and `amount`...

Plugin flow on `Transaction Payment Created`:
1. Insert `MessageId` into dedupe table; if duplicate, return 200 and stop.
2. `GET /checkout/v2/isv/transactions/{transactionId}?merchantId={uuid}`.
3. Validate `orderCode`, `statusId`, `amount` against the Vendure payment record.
4. Call `settlePayment` only if validation passes.
5. Update dedupe row with `ProcessedAt`.

### `Transaction Failed` is NOT terminal

Verbatim `wh-transaction-failed.txt:126–127`:

> please do not treat a Transaction Failed webhook as 'final', as a Transaction Payment Created webhook may follow, indicating a successful payment.

Plugin must mark the payment `Declined` but **leave the order in `ArrangingPayment`** so a customer retry on the same `orderCode` can still succeed. Locked decision A1's "no auto-rollback on failure" matches this Viva guarantee.

### No webhook for some failure modes

`wh-transaction-failed.txt:119–121`:

> Webhook notifications will not be triggered for cancelled transactions, or for payments that failed 3DS user authentication... no notification will be triggered upon expiration of a payment order.

For these cases — 3DS abort, customer back-button on Smart Checkout, payment-order expiry — **the stale-order sweep (§5) is the only recovery path.** This is why A1's 30-min sweep window is load-bearing.

### `Order Updated` webhook (EventTypeId 4865)

Viva fires this when an order is cancelled via Smart Checkout's back button or via API (`webhooks-for-payments.txt:204–207`). Subscribing gives the plugin an earlier signal of cancellation than waiting for the storefront's `?paymentCancelled=1` redirect. **Optional** — the redirect-back path works without it — but worth implementing for snappier basket-state recovery.

### Webhook registration scope — ISV-level (one URL, all merchants)

Viva supports both ISV-level webhooks (one URL covers every connected merchant) and per-merchant webhooks (one URL each). **For this plugin, register at the ISV level.** Single URL, plugin routes per-merchant logic via `EventData.MerchantId` (and `EventData.ConnectedAccountId` where applicable) inside the payload.

Setup:
1. Use ISV credentials to generate a webhook verification key.
2. Register one webhook URL per event type the plugin subscribes to (`Transaction Payment Created` 1796, `Transaction Failed` 1798, optionally `Order Updated` 4865).
3. Endpoint must respond to Viva's URL-verification GET with `{"key": "<verification-key>"}`.

This keeps plugin setup at O(1) per event type rather than O(merchants × event types).

---

## 5. Stale-order sweep coordination — RESOLVED: recover the order

**Decision:** when `settlePayment` is called on an order whose state is `AddingItems` (already rolled back by the sweep), the plugin re-walks the canonical Vendure state machine — `AddingItems → ArrangingPayment → PaymentAuthorized → PaymentSettled` — and settles cleanly. The customer gets the order they paid for; the late webhook is recovered, not silently dropped.

**Why:** money already moved in good faith. Auto-refund punishes a customer whose only crime was a slow webhook; quarantine doesn't scale.

**Sweep details:** runs every 5min in `apps/server` via `@vendure/scheduler-plugin` inside `shoppro-plugin`. Finds orders in `ArrangingPayment` older than 30min and transitions them back to `AddingItems`. The sweep is even more critical now that we know 3DS-fail and order-expiry don't fire any webhook — without the sweep, those orders would be stranded forever.

---

## 6. Apple Pay domain verification — manual per-merchant

**Confirmed:** ISV partners CANNOT register Apple Pay domains via API. The Native Apple Pay API integration is not exposed to ISV partners. Each merchant must register their own domain manually via their Viva dashboard.

**Operator workflow per shop:**
1. Shop principal logs into their Viva dashboard.
2. Downloads the `apple-developer-merchantid-domain-association` file specific to their merchant ID.
3. Hands it to platform ops.
4. Ops places it at `<storefront-origin>/.well-known/apple-developer-merchantid-domain-association`.

Without it, Apple Pay silently disappears from Smart Checkout on Safari iOS.

**Plugin responsibilities:**
- README should warn loudly that this is a per-shop manual step that gates Apple Pay.
- Optionally: a Channel custom field `vivaApplePayDomainVerified: boolean` that ops flips after the file is in place — purely operational tracking, not a runtime gate.

Tracked as TODO T20 in retail-commerce.

---

## 7. Configuration surface

The plugin runs in **ISV mode** with platform-wide credentials and per-Channel merchant resolution.

```ts
VivaPaymentPlugin.init({
  // ISV partner credentials — one set, platform-wide.
  // Same pair across demo and live — `environment` flag switches host only.
  isvClientId: process.env.VIVA_ISV_CLIENT_ID!,
  isvClientSecret: process.env.VIVA_ISV_CLIENT_SECRET!,

  environment: 'demo' | 'production',

  // Webhook URL-verification key (returned on Viva's GET probe at registration).
  // NOT a per-request HMAC — Viva does not sign webhook bodies.
  webhookVerificationKey: process.env.VIVA_WEBHOOK_VERIFICATION_KEY!,

  // Per-Channel resolution — read from Channel custom fields.
  resolveMerchantId: (ctx) => string,        // UUID — required, no default
  resolveSourceCode: (ctx) => string,        // optional — defaults to 'Default' (web payments)
  resolveIsvAmount: (order, ctx) => number,  // commission split in minor units; MUST be < amount

  // Per-request URLs — supplied by the storefront via order metadata.
  // Plugin substitutes {orderCode} server-side after Viva returns it.
  successUrl: '{channel.origin}/order-confirmation/{orderCode}',
  failureUrl: '{channel.origin}/?paymentCancelled=1',
})
```

**Key constraints:**
- **OAuth2 client_credentials only.** Two ISV credentials, not four. The Laravel-pkg-style `isv_partner_id` / `isv_partner_api_key` Basic-Auth pair is *not* used by the official ISV `Create Payment Order` endpoint.
- **Token lifetime:** 3600s, no refresh_token. Plugin must cache + refresh proactively.
- **`merchantId` is a UUID query parameter on every ISV API call.** Same OAuth bearer works across all merchants.
- **`resolveIsvAmount` must enforce `isvAmount < amount`.** Verbatim `isv-partner-program.txt:299–300`: "If the ISV fee exceeds the total amount, the payment will be declined. So we suggest you run a check..." Guard before calling the API.
- **GBP currency:** plugin sends `currencyCode: 826` (numeric ISO 4217) for UK shops. Webhooks return it as a string `"826"` — coerce with care.
- **`successUrl` `{orderCode}` substitution** is critical — Viva needs a per-order confirmation URL.
- **`vivaSourceCode` defaults to `'Default'`** for web payments. Per `payment-source-for-isv.txt:86`: "any sources created in this fashion can be used for physical location payments only. For web-based payments, use the 'Default' source code." Operators should not change this unless they have a POS/hybrid setup.

---

## 8. Refund flow (post-v0) — ISV reversal is automatic

Out of scope for v0. `TODOS.md` T5 (49p refund transaction boundary) describes the saga the storefront wants on full refunds.

**ISV economics on refund — confirmed:** "If a merchant refunds a transaction to a customer, then the ISV fee that was withheld for this transaction will be reversed" (`isv-partner-program.txt:295–297`). The plugin's refund handler does not need to specify or recalculate the split; Viva auto-reverses `isvAmount`.

---

## 9. Multi-Channel — DAY-ONE ARCHITECTURE (not post-v0)

ISV is multi-tenant by definition. Even with only Goldenacre live, the plugin must:

1. Resolve `merchantId` per-Channel from a custom field. Never hardcode.
2. Issue OAuth2 tokens against the ISV credentials (one platform-wide pair); reuse the bearer across merchants.
3. Pass `?merchantId=` on every ISV API call (`/checkout/v2/isv/orders`, `/checkout/v2/isv/transactions/...`, etc.).
4. Use `(MessageId)` as the dedupe primary key, with `(MerchantId, TransactionId, EventTypeId)` as supplementary lookups for the settle path.
5. Carry `merchantId` through to refund and pre-auth flows (post-v0) the same way.

The `shoppro-plugin` registers Channel custom fields:

```ts
{
  name: 'vivaAccountId',
  type: 'string',
  // Returned by Create a connected account; used for the Retrieve call after
  // verification fires. Populated immediately when onboarding is initiated.
}
{
  name: 'vivaMerchantId',
  type: 'string',
  ui: { component: 'text-form-input' },
  // UUID v4 — written automatically by the plugin's webhook handler after
  // Account Verification Status Changed fires and the Retrieve call returns it.
  // See §10.
}
{
  name: 'vivaPayoutsEnabled',
  type: 'boolean',
  defaultValue: false,
  // Flipped true by the Account Verification Status Changed webhook handler
  // once vivaMerchantId is populated. Storefront uses this as the runtime gate.
}
{
  name: 'vivaSourceCode',
  type: 'string',
  defaultValue: 'Default',
  // Stays 'Default' for web-only shops. POS/hybrid setups use a custom code.
}
```

The Viva plugin reads `vivaMerchantId` and `vivaSourceCode` via the `resolveMerchantId` / `resolveSourceCode` callbacks in §7. It writes `vivaAccountId`, `vivaMerchantId`, and `vivaPayoutsEnabled` itself during onboarding (§10).

---

## 10. Onboarding — programmatic, ISV-initiated, VivaWallet handles verification

ISV calls Viva's API to initiate onboarding; VivaWallet handles all KYC/KYB verification automatically (`isv-partner-program.txt:189–191`: "Throughout the onboarding process, Viva handles all due diligence and verification steps... with no further action or input required by the ISV Partner."). Activation is "fast, digital, and user-friendly, with instant activation for merchants."

### Two distinct IDs

- **`accountId`** — returned by `Create a connected account`. Identifies the connected account at Viva. Used to call `Retrieve information about a connected account` later. NOT what goes into `?merchantId=` on payment calls.
- **`merchantId`** (UUID) — returned by `Retrieve information about a connected account` AFTER verification. THIS is what every payment / transaction API call uses as `?merchantId={uuid}`.

The plugin must track both per-Channel.

### Flow

1. **Operator clicks "Onboard new shop to Viva"** in the Vendure admin, scoped to a Channel that has a Seller (legal entity, address, contact email).
2. **Plugin POSTs `Create a connected account`** with the Seller's details. Response: `{ accountId, onboardingUrl }`.
3. **Plugin stores `accountId`** on the Channel (custom field `vivaAccountId`) and emails / surfaces the `onboardingUrl` for the operator to send to the shop principal.
4. **Merchant completes Viva's hosted KYC/KYB flow.**
5. **Viva fires `Account Verification Status Changed`** webhook when status flips to verified. Payload includes `accountId` (and `ConnectedAccountId` per the user-confirmed §11 row).
6. **Plugin's webhook handler calls `Retrieve information about a connected account`** (by `accountId`) → returns `merchantId` plus email/verification metadata.
7. **Plugin writes `merchantId` to the Channel's `vivaMerchantId` custom field** and flips `vivaPayoutsEnabled: true`.
8. **Storefront's "checkout available" gate flips automatically** — no operator copy-paste needed.

### Webhooks the plugin subscribes to for onboarding

- `Account Connected` — fired when a merchant first links to the ISV. Useful for analytics; not gating.
- `Account Verification Status Changed` — fired when verification completes. **THIS is the gating signal** that triggers the Retrieve + write-merchantId step.

Both registered ISV-level (one URL handles all merchants — see §4). Same dedupe table (`viva_webhook_event` keyed on `MessageId`) covers them.

### What the plugin does

- Admin action: "Onboard new shop to Viva" (POST `Create a connected account`, store `accountId`, surface `onboardingUrl`).
- Webhook subscription + handler for `Account Verification Status Changed` → calls `Retrieve information about a connected account` → writes `merchantId` to Channel.
- Storefront-facing gate: refuse to render the Viva CTA until `vivaPayoutsEnabled: true`.

### What the plugin does NOT do

- Collect KYC/KYB data on a custom admin form. VivaWallet's hosted flow handles all of it.
- Block the operator from copying `merchantId` manually — the auto-write is the happy path; manual paste is the recovery path if a webhook is missed.

---

## 11. All resolved decisions (2026-04-25)

| # | Question | Resolution |
|---|---|---|
| §2 | `createPayment` return state — Authorized or Created? | **Created** — webhook is trigger, Retrieve Transaction is truth. |
| §3 | Cancel ownership — plugin or storefront? | **Plugin owns cancel** via `cancelPayment(paymentId)`. |
| §4 | Webhook dedupe key? | **`MessageId`** (envelope UUID), not `TransactionId`. |
| §4 | Webhook auth mechanism? | **IP allowlist + URL-verify GET handshake** at registration; no HMAC. |
| §4 | Is `MerchantId` in webhook payloads? | **Yes** — `EventData.MerchantId` (UUID) on both 1796 and 1798. |
| §4 | What about 3DS-fail / order-expiry / cancel-via-backbutton? | **No webhook fires.** Stale-sweep (§5) is the only recovery. |
| §4 | Trust the webhook body to settle? | **No** — always Retrieve Transaction first to validate. |
| §4 | Is `Transaction Failed` terminal? | **No** — a retry can fire `Transaction Payment Created` afterward. |
| §5 | Settle-after-sweep behaviour? | **Recover the order** — re-walk the state machine. |
| §7 | OAuth token TTL / refresh? | **3600s, no refresh_token.** Re-issue via client_credentials. |
| §7 | `isvAmount` constraint? | **Must be < amount** or Viva declines the payment. |
| §8 | Refund reverses `isvAmount` automatically? | **Yes** — no special handling needed in refund handler. |
| §10 | Who owns onboarding flow / KYC? | **VivaWallet, end-to-end.** ISV just gets a `redirectUrl` to share. |
| §6 | Can ISV partners register Apple Pay domains via API? | **No** — manual per-merchant via each shop's Viva dashboard. |
| §7 | OAuth client pair scope across environments? | **One pair covers demo + live.** `environment` flag switches host only. |
| §4 | Is `ConnectedAccountId` populated for live ISV transactions? | **Yes** — reliable in production; sample-payload `null`s were non-ISV demo traffic. |
| §1 | What does `POST /checkout/v2/isv/orders` return? | **Only `orderCode`** — plugin constructs `https://[demo-]www.vivapayments.com/web/checkout?ref={orderCode}` itself. |
| §4 | Webhook registration scope — ISV-level or per-merchant? | **ISV-level** — one URL per event type covers all connected merchants; route per-merchant via `EventData.MerchantId` in payload. |

**Storefront-side follow-ups** (Phase B, when the plugin lands):
- Simplify `cancelArrangingPayment` server action (commit `c3442d1`) to a thin wrapper around `cancelPayment(paymentId)`; drop the local `transitionOrderToState('AddingItems')`. Update locked A1 in `docs/plans/interior-pages-redesign.md` accordingly.
- Confirm `{orderCode}` substitution in §7 lines up with the storefront's `/order-confirmation/[code]` route.
- Wire `shoppro-plugin` Channel custom fields per §9.

---

## 12. Open items — none

All discovery-call items resolved 2026-04-25 (see §11). No payment-side blockers.