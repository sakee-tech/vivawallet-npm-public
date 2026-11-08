# Viva Wallet — Authentication Reference

> Where to use Basic auth, where to use OAuth2, and what "legacy" actually means.
>
> Grounded in `docs/payment-api.yaml` (16k lines) and `docs/payment-isv-api.yaml` (7.6k lines), both pulled 2026-05-12.

---

## TL;DR

Viva has **two parallel auth schemes** — both are current, both are documented, both will keep working. Neither is "legacy" in the deprecated sense.

| Scheme | Where it's used | What you need |
|---|---|---|
| **OAuth2 client_credentials** | Real-time payments + transaction reads + ISV onboarding + ISV webhook registration + Fast Refund | `client_id` + `client_secret` (Self Care → API Access → Smart Checkout, or → ISV Partner) |
| **Basic auth** | Standard refund + payment source creation + account/wallet admin + merchant webhook verification key | `MerchantId:ApiKey` **or** `ResellerId:MerchantId` + `ResellerApiKey` (depending on endpoint) |

The plugin uses BOTH. Today's `LegacyBasicClient` name is **misleading** — rename suggested to `BasicAuthClient` in §6.

---

## 1. The two auth schemes

### 1.1 OAuth2 client_credentials

- Spec: RFC 6749 §4.4 — `grant_type=client_credentials`.
- Token endpoint: `POST https://{accounts-host}/connect/token`
  - Demo: `https://demo-accounts.vivapayments.com`
  - Live: `https://accounts.vivapayments.com`
- Token TTL: **3600 s** (1 hour). No refresh_token. Plugin caches + refreshes ~5 min before expiry.
- Same client pair works for demo + live; `environment` flag switches the resource host only.
- Token returned with scope set; see §3 for the scope-per-endpoint matrix.
- Used against modern API hosts:
  - Demo: `https://demo-api.vivapayments.com`
  - Live: `https://api.vivapayments.com`

### 1.2 Basic auth

- HTTP `Authorization: Basic base64(username:password)`.
- Two flavours, distinguished by username shape:

| Flavour | Username | Password | Self Care lookup |
|---|---|---|---|
| **Merchant Basic** | `MerchantId` (UUID) | `ApiKey` | Self Care → Settings → API Access → Merchant credentials |
| **Reseller Basic** | `ResellerId:MerchantId` (two UUIDs joined with colon) | `ResellerApiKey` | Self Care → ISV Partner → Reseller credentials |

- Used against the **Basic-auth API hosts** (Viva calls these their "merchant API" surface):
  - Demo: `https://demo.vivapayments.com`
  - Live: `https://www.vivapayments.com`
- **Different host from the OAuth2 surface.** Note: `api.vivapayments.com` ≠ `www.vivapayments.com`.

---

## 2. Are these "legacy"?

**No.** Neither auth scheme is deprecated by Viva.

- Both are listed in the current OpenAPI specs (`payment-api.yaml`, `payment-isv-api.yaml`).
- Both have current sandbox + production hosts.
- Specific **endpoints** are deprecated within both schemes (see §5), but the auth schemes themselves are first-class.

### Why "legacy" appears in our code

The plugin's `LegacyBasicClient` was named to distinguish "the older host with HTTP Basic auth" from "the newer OAuth2 host." But Viva does not call the Basic-auth surface "legacy" — they call it their **merchant API**, alongside the OAuth2 **acquiring / checkout / ISV / platform** APIs.

**Recommendation:** rename `LegacyBasicClient` → `BasicAuthClient` in the v0.2.0 core refactor. One-line CHANGELOG migration note.

---

## 3. Endpoint matrix — what auth for what operation

### 3.1 Smart Checkout (payment orchestration)

| Operation | Path | Auth | Scope / Cred | Host |
|---|---|---|---|---|
| Create order — merchant | `POST /checkout/v2/orders` | OAuth2 | `urn:viva:payments:core:api:redirectcheckout` | `*-api.vivapayments.com` |
| Create order — marketplace | `POST /checkout/v2/orders/` *(trailing slash)* | OAuth2 | `urn:viva:payments:core:api:acquiring urn:viva:payments:core:api:acquiring:cardtokenization urn:viva:payments:core:api:acquiring:transactions urn:viva:payments:core:api:platform urn:viva:payments:core:api:redirectcheckout` | `*-api.vivapayments.com` |
| Create order — ISV | `POST /checkout/v2/isv/orders?merchantId={uuid}` | OAuth2 | `urn:viva:payments:core:api:isv urn:viva:payments:core:api:redirectcheckout` | `*-api.vivapayments.com` |
| Retrieve transaction | `GET /checkout/v2/transactions/{transactionId}` | OAuth2 | `urn:viva:payments:core:api:redirectcheckout` | `*-api.vivapayments.com` |
| Retrieve transaction (ISV) | `GET /checkout/v2/isv/transactions/{transactionId}?merchantId={uuid}` | OAuth2 | `urn:viva:payments:core:api:isv urn:viva:payments:core:api:redirectcheckout` | `*-api.vivapayments.com` |
| Retrieve order (by orderCode) | `GET /api/orders/{orderCode}` | **Basic** | Merchant Basic `MerchantId:ApiKey` (M) / Reseller 3-part `ResellerId:ConnectedMerchantId:ResellerApiKey` (I) | **legacy host** (`demo.vivapayments.com` / `www.vivapayments.com`) |
| Cancel order (void auth) | `DELETE /api/orders/{orderCode}` | **Basic** | Merchant Basic `MerchantId:ApiKey` (M) / Reseller 3-part `ResellerId:ConnectedMerchantId:ResellerApiKey` (I) | **legacy host** (`demo.vivapayments.com` / `www.vivapayments.com`) |

### 3.2 Refunds (two paths — both current)

| Operation | Path | Auth | Scope / Cred | Host | Notes |
|---|---|---|---|---|---|
| **Fast Refund** | `POST /acquiring/v1/transactions/{transactionId}:fastrefund` | OAuth2 | `urn:viva:payments:core:api:acquiring urn:viva:payments:core:api:acquiring:transactions` | `*-api.vivapayments.com` | Visa/MC e-commerce only; merchant must be approved by Viva sales; near-real-time. Webhook 1797 `ServiceId = 19`. |
| **Standard refund** (Cancel transaction) | `DELETE /api/transactions/{transactionId}?amount=&sourceCode=&currencyCode=` | Basic | **merchant mode**: Merchant Basic (`MerchantId:ApiKey`) · **ISV mode**: Reseller Basic (`base64(ResellerId:ConnectedMerchantId:ResellerApiKey)`, Viva-issued) | `*.vivapayments.com` | `DELETE`, params in query (not body). All cards/methods/merchants; T+2. Success = `StatusId 'F'`. POST on this path is pre-auth **capture**, not refund. |
| Cancel rebate / fast refund | `DELETE /acquiring/v1/transactions/{transactionId}` | OAuth2 | `urn:viva:payments:core:api:acquiring urn:viva:payments:core:api:acquiring:transactions` | `*-api.vivapayments.com` | Same-day only. Out of v0.2.x scope. |

### 3.3 Payment sources

| Operation | Path | Auth | Scope / Cred | Host |
|---|---|---|---|---|
| Create source (merchant) | `POST /api/sources` | Basic | Merchant Basic (`MerchantId:ApiKey`) | `*.vivapayments.com` |
| Create source (ISV — for connected merchant) | `POST /api/sources` | Basic | **Reseller Basic** (`ResellerId:MerchantId` + `ResellerApiKey`) | `*.vivapayments.com` |

> ISV mode: the `MerchantId` part of the Reseller Basic username is the *connected merchant's* UUID, not the platform's.

### 3.4 ISV onboarding + webhooks

| Operation | Path | Auth | Scope |
|---|---|---|---|
| Create connected account | `POST /isv/v1/accounts` | OAuth2 (ISV) | `urn:viva:payments:core:api:isv urn:viva:payments:core:api:redirectcheckout` |
| Retrieve connected account | `GET /isv/v1/accounts/{accountId}` | OAuth2 (ISV) | same |
| Generate webhook verification key | `GET /isv/v1/webhooks/token` | OAuth2 (ISV) | same |
| Register webhook URL | `POST /isv/v1/webhooks` | OAuth2 (ISV) | same |

### 3.5 Merchant webhook setup (non-ISV)

| Operation | Path | Auth | Notes |
|---|---|---|---|
| Generate webhook verification key | `GET /api/messages/config/token` | Basic (Merchant) | Used by merchant + marketplace modes — Viva returns the key, operator pastes the webhook URL into Self Care UI |
| Register payment webhook URL | **manual in Viva Self Care UI** | — | No API for registering 1796/1797/1798/4865 in merchant mode. (`/dataservices/v1/webhooks/subscriptions` exists but is restricted to `SaleTransactionsFileGenerated` per `payment-api.yaml:608`.) |

### 3.6 Marketplace platform endpoints *(deferred — v0.2.x reserves seams only)*

| Operation | Path | Auth |
|---|---|---|
| Create connected account | `POST /platforms/v1/accounts` | OAuth2 (platform scopes) |
| Retrieve connected account | `GET /platforms/v1/accounts/{accountId}` | OAuth2 |
| Create transfer | `POST /platforms/v1/transfers` | OAuth2 |

### 3.7 Other (out of plugin scope, listed for completeness)

| Domain | Auth | Examples |
|---|---|---|
| Wallets, bank accounts, fees | Basic (Merchant) | `/api/wallets`, `/api/bankaccounts`, `/api/fees` |
| Bank transfers | OAuth2 | `/banktransfers/v1/...` |
| Data services (reports, exports) | OAuth2 | `/dataservices/v1/...`, `/dataservices/v2/...` |
| Resellers (reseller-driven payments) | OAuth2 | `/resellers/v1/...` |
| Card tokenization | OAuth2 | `/acquiring/v1/cards/tokens` |
| Obligations | OAuth2 | `/obligations/v1/obligations` |

---

## 4. OAuth2 scopes — what each scope unlocks

| Scope | Purpose | Plugin uses it for |
|---|---|---|
| `urn:viva:payments:core:api:redirectcheckout` | Smart Checkout (Hosted Checkout v2) | create/retrieve/cancel orders + transactions |
| `urn:viva:payments:core:api:isv` | ISV-specific endpoints (`/isv/v1/*`, `/checkout/v2/isv/*`) | ISV mode |
| `urn:viva:payments:core:api:acquiring` | Acquiring-level operations | Fast Refund |
| `urn:viva:payments:core:api:acquiring:transactions` | Transaction-level acquiring ops | Fast Refund + future pre-auth increase |
| `urn:viva:payments:core:api:acquiring:cardtokenization` | Card token operations | not used by v0.2.x |
| `urn:viva:payments:core:api:platform` | Platform / marketplace ops | reserved for marketplace mode |
| `urn:viva:payments:core:api:nativecheckoutv2` | Native checkout (not Smart Checkout) | not used |
| `urn:viva:payments:biservices:merchantapi` | Business intelligence | not used |
| `urn:viva:payments:ecr:api` | POS/ECR integration | not used |
| `urn:viva:payments:biservices:datafileapi` | Sale-transaction file exports | not used |

**Probe finding 2026-05-11**: requesting OAuth2 token with no `scope` parameter returns a token with **all** of these scopes attached (the platform grants the union of permitted scopes). The plugin requests scopes explicitly anyway — defensive against future tightening.

---

## 5. Deprecated endpoints (don't use)

From the OpenAPI specs as of 2026-05-12. None of these affect the plugin's current usage, but worth listing so future work knows to avoid them:

| Endpoint | Deprecation note |
|---|---|
| `POST /api/orders` (Basic) | "Use `/checkout/v2/orders` instead" — current code already does. NOTE: this is **create only**; `DELETE /api/orders/{orderCode}` (cancel) is **current**, not deprecated — it is the only working cancel route (the OAuth2 `/checkout/v2/orders/{oc}` returns 404). See §3.1. |
| `POST /api/bankaccounts` (Basic) | bank account creation moved to OAuth2 `/banktransfers/v1/bankaccounts` |
| `GET /api/bankaccounts/{id}` (Basic) | same |
| `POST /api/wallets/{walletId}/commands/banktransfer/{bankAccountId}` (Basic) | moved to OAuth2 banktransfers |
| `GET /api/wallets` (Basic) | use `/merchants/v1/wallets` (OAuth2) |
| `DELETE /api/transactions/{transaction_id}` "Pay Out (OLD)" (ISV) | "Pay Out is now deprecated. Contact your Sales representative." |

The endpoints the plugin uses today (`DELETE /api/transactions/{id}` for refund, `POST /api/sources` for source creation, `GET /api/messages/config/token` for webhook key) are **not** marked deprecated.

---

## 6. Plugin implementation guidance

### 6.1 Naming (to be applied in v0.2.0)

- `IsvHttpClient` → keep (it's the modern-OAuth2 client; name accurate for ISV scope).
- Introduce `HttpClient` (mode-agnostic OAuth2 client) in core when `IsvPayments` is renamed to `Payments` — or keep one client class with a `scope` field set per mode.
- `LegacyBasicClient` → **rename to `BasicAuthClient`**. Two reasons:
  1. Viva does not call this surface "legacy"; it's their merchant API.
  2. We'll use it for current, non-deprecated endpoints (`/api/sources`, `/api/transactions/{id}`, `/api/messages/config/token`).
- `BasicAuthClient` carries a `authVariant: 'merchant' | 'reseller'` field. Refund + webhook-token use `'merchant'`; source creation in ISV uses `'reseller'`.

### 6.2 Strategy table per plugin mode

| Plugin mode | OAuth2 client | Basic auth client(s) | When each fires |
|---|---|---|---|
| `merchant` | merchant's own pair → `redirectcheckout` (+ `acquiring`/`acquiring:transactions` if Fast Refund enabled) | one `BasicAuthClient` in `'merchant'` variant | OAuth2 for checkout/retrieve/cancel/Fast-Refund; Basic-merchant for standard refund + webhook key fetch |
| `isv` | platform pair → `isv redirectcheckout` (+ acquiring scopes for Fast Refund) | `'reseller'` variant `BasicAuthClient`, built per connected merchant — used for BOTH standard refund and source creation. **No `'merchant'` variant** — an ISV holds no connected merchant's `ApiKey`; refund auth is the Viva-issued Reseller pair. | OAuth2 for checkout/retrieve/cancel/Fast-Refund/onboarding/webhook-reg; Basic-reseller for refund + source creation |
| `marketplace` *(not implemented — `VivaMode` is `'merchant' | 'isv'` only)* | n/a | n/a | reserved; no code path |

### 6.3 Refund strategy (v0.2.0)

Two paths exist (§3.2). Plugin chooses at call time:

1. **If Fast Refund eligible** (Visa/MC card scheme from `retrieveTransaction` response **and** merchant approved **and** original transaction is e-commerce): try Fast Refund first.
2. **Else, or on Fast-Refund 403 "not eligible":** fall back to standard refund (Basic auth).

Plugin exposes a config knob: `refundStrategy: 'auto' | 'fast' | 'standard'` (default `'auto'`). Merchants who know they're not approved for Fast Refund can set `'standard'` to skip the probe call.

### 6.4 Token caching

- OAuth2 token cached in-process by default; multi-worker deployments inject a Redis lock for refresh coordination (`RedisLockClient` interface in `viva-payments-core/auth`).
- Refresh ~5 min before expiry (`expires_in - 300`).
- On 401 from any OAuth2 endpoint: force-refresh once, retry once.
- Basic auth: no caching (credentials are static; `Authorization` header rebuilt per request).

### 6.5 Where to put the credentials

| Config field | Used by | When required |
|---|---|---|
| `clientId` / `clientSecret` | OAuth2 strategy | always |
| `legacyMerchantId` / `legacyApiKey` | `BasicAuthClient` (merchant variant) | **merchant mode only** — webhook key + standard refund. Inapplicable in ISV mode. |
| `reseller.resellerId` / `reseller.merchantId` / `reseller.resellerApiKey` | `BasicAuthClient` (reseller variant) | **ISV mode** — required for standard **refund** and for source creation. These are the **Viva-issued** Reseller ID/Key (demo and production pairs differ; production obtained from Viva Support), NOT dashboard ISV credentials. The per-call `merchantId` slot uses the *connected merchant's* UUID, not `reseller.merchantId`. |


---

## 7. Quick decision tree

```
Calling Viva to … ?

  Pay / read transaction / cancel order
      → OAuth2  →  *-api.vivapayments.com

  Refund — and merchant is Fast-Refund approved + card is Visa/MC + e-commerce
      → OAuth2  →  POST /acquiring/v1/transactions/{id}:fastrefund

  Refund — otherwise (Viva "Cancel transaction")
      → Basic  →  DELETE /api/transactions/{id}?amount=&sourceCode= on *.vivapayments.com
          merchant mode  → Merchant Basic (MerchantId:ApiKey)
          ISV mode       → Reseller Basic (ResellerId:ConnectedMerchantId / ResellerApiKey, Viva-issued)

  Create payment source
      → Basic
          merchant mode  → Merchant Basic (MerchantId:ApiKey)
          ISV mode       → Reseller Basic (ResellerId:MerchantId / ResellerApiKey)
      → POST /api/sources on *.vivapayments.com

  Onboard a connected merchant (ISV)
      → OAuth2 (ISV scope)  →  POST /isv/v1/accounts

  Register webhook URL (ISV)
      → OAuth2 (ISV scope)
          GET  /isv/v1/webhooks/token   (verification key)
          POST /isv/v1/webhooks          (register URL per event)

  Register webhook URL (merchant / marketplace)
      → Basic (Merchant) for the verification key only
          GET /api/messages/config/token
      → Then paste URL into Self Care UI manually (no API for this)
```

---

## 8. Credential lookup paths (Viva Self Care)

| Credential | Where in Self Care |
|---|---|
| OAuth2 `client_id` / `client_secret` (merchant) | Settings → API Access → Smart Checkout → Credentials |
| OAuth2 `client_id` / `client_secret` (ISV) | ISV Partner → API Credentials |
| `MerchantId` / `ApiKey` (Merchant Basic) | Settings → API Access → Merchant credentials |
| `ResellerId` / `ResellerApiKey` (Reseller Basic) | ISV Partner → Reseller credentials |
| Webhook URL registration UI (merchant) | Sales → API Access → Webhooks |
| Source codes UI (manual creation) | Sales → Online Payments → Websites/Apps (e-commerce), Physical Payments → Stores (in-person) |

---

## 9. Hosts matrix — live vs demo

Viva runs **three distinct host families** per environment (token / OAuth2 API / Basic API), plus a few ancillary hosts for the Self Care UI and onboarding redirects.

### 9.1 The three API host families

| Purpose | Demo (sandbox) | Live (production) | Used by |
|---|---|---|---|
| **OAuth2 token endpoint** | `https://demo-accounts.vivapayments.com/connect/token` | `https://accounts.vivapayments.com/connect/token` | All OAuth2-secured endpoints — fetch a Bearer token here, then call the OAuth2 API host with it. |
| **OAuth2 API host** (modern) | `https://demo-api.vivapayments.com` | `https://api.vivapayments.com` | `/checkout/v2/...`, `/checkout/v2/isv/...`, `/acquiring/v1/...`, `/isv/v1/...`, `/platforms/v1/...`, `/banktransfers/v1/...`, `/dataservices/v1/...`, `/merchants/v1/...`, `/resellers/v1/...`, `/obligations/v1/...` |
| **Basic auth API host** (merchant API) | `https://demo.vivapayments.com` | `https://www.vivapayments.com` | `/api/transactions/{id}` (refund), `/api/sources` (source creation), `/api/messages/config/token` (webhook verification key), `/api/orders` *(deprecated)*, `/api/wallets/*`, `/api/bankaccounts/*` *(deprecated)*, `/api/fees` |

The Basic-auth host is a **completely separate hostname** from the OAuth2 API host — `www.vivapayments.com` is NOT the same as `api.vivapayments.com`. Don't try to send Basic auth to `api.*` or OAuth2 to `www.*`.

### 9.2 Ancillary hosts

| Purpose | Demo | Live |
|---|---|---|
| **Self Care web app** (operator UI — credentials, source codes, webhook registration UI) | `https://demo.vivapayments.com/en/signup`, `https://members.vivawallet.com/en/signin` *(unified signin)* | `https://www.vivapayments.com`, `https://members.vivawallet.com/en/signin` |
| **Customer-facing app** (onboarding redirect URLs from `POST /isv/v1/accounts` invitations land here) | `https://demo-app.vivapayments.com/register/invite/...` *(probe-verified 2026-05-11)* | `https://app.vivapayments.com/...` *(inferred; confirm at first live ISV onboarding)* |
| **Developer portal** (docs) | `https://developer.viva.com`, alias `https://developer.vivawallet.com` | (same) |
| **UAT** (account-api tutorials only — not used by the plugin) | `https://uat-api.vivapayments.com` | — |

### 9.3 Per-endpoint host quick reference (plugin's actual call surface)

| Plugin call | Demo URL | Live URL |
|---|---|---|
| OAuth2 token | `POST https://demo-accounts.vivapayments.com/connect/token` | `POST https://accounts.vivapayments.com/connect/token` |
| Create order (merchant) | `POST https://demo-api.vivapayments.com/checkout/v2/orders` | `POST https://api.vivapayments.com/checkout/v2/orders` |
| Create order (ISV) | `POST https://demo-api.vivapayments.com/checkout/v2/isv/orders?merchantId={uuid}` | `POST https://api.vivapayments.com/checkout/v2/isv/orders?merchantId={uuid}` |
| Retrieve transaction | `GET https://demo-api.vivapayments.com/checkout/v2/transactions/{id}` | `GET https://api.vivapayments.com/checkout/v2/transactions/{id}` |
| Cancel order | `DELETE https://demo.vivapayments.com/api/orders/{orderCode}` (Basic) | `DELETE https://www.vivapayments.com/api/orders/{orderCode}` (Basic) |
| Fast Refund | `POST https://demo-api.vivapayments.com/acquiring/v1/transactions/{id}:fastrefund` | `POST https://api.vivapayments.com/acquiring/v1/transactions/{id}:fastrefund` |
| Standard refund | `DELETE https://demo.vivapayments.com/api/transactions/{id}?amount=&sourceCode=` | `DELETE https://www.vivapayments.com/api/transactions/{id}?amount=&sourceCode=` |
| Create source | `POST https://demo.vivapayments.com/api/sources` | `POST https://www.vivapayments.com/api/sources` |
| Webhook verification key (merchant) | `GET https://demo.vivapayments.com/api/messages/config/token` | `GET https://www.vivapayments.com/api/messages/config/token` |
| ISV — create connected account | `POST https://demo-api.vivapayments.com/isv/v1/accounts` | `POST https://api.vivapayments.com/isv/v1/accounts` |
| ISV — get connected account | `GET https://demo-api.vivapayments.com/isv/v1/accounts/{accountId}` | `GET https://api.vivapayments.com/isv/v1/accounts/{accountId}` |
| ISV — webhook verification key | `GET https://demo-api.vivapayments.com/isv/v1/webhooks/token` | `GET https://api.vivapayments.com/isv/v1/webhooks/token` |
| ISV — register webhook | `POST https://demo-api.vivapayments.com/isv/v1/webhooks` | `POST https://api.vivapayments.com/isv/v1/webhooks` |

### 9.4 Environment switching in the plugin

A single `environment: 'demo' | 'production'` flag in `VivaPluginConfig` switches **all** host pairs at once. The plugin does not allow mixed-environment use (e.g., demo OAuth2 + live Basic auth) — would be a security risk and a debugging nightmare.

```ts
// Internal host resolver — viva-payments-core/auth or /config
function resolveHosts(env: 'demo' | 'production') {
  return env === 'production'
    ? {
        oauthToken:  'https://accounts.vivapayments.com',
        oauthApi:    'https://api.vivapayments.com',
        basicApi:    'https://www.vivapayments.com',
      }
    : {
        oauthToken:  'https://demo-accounts.vivapayments.com',
        oauthApi:    'https://demo-api.vivapayments.com',
        basicApi:    'https://demo.vivapayments.com',
      };
}
```

### 9.5 Webhook IP allowlists

The plugin allowlists Viva's source IPs on the webhook receiver. Demo + production have **different CIDR sets** — the plugin defaults to the union of both (so a single deploy can receive demo + production traffic during testing), but operators can override per-environment.

Viva publishes the CIDRs in their developer portal; the plugin's default list is in `viva-payments-core/webhooks`. Verify the list at the first live demo and on any allowlist-mismatch 403.

### 9.6 OAuth2 client pair scope across environments

**One client pair (`client_id` + `client_secret`) works for both demo and live** per Viva's docs (`oauth2-authentication.txt:145`). The pair is environment-specific only insofar as it's created in either the demo or live Self Care account — not in the API endpoint it talks to. Plugin's `environment` flag picks the host; the same credentials authenticate at either accounts host.

### 9.7 What is `developer.viva.com` vs `developer.vivawallet.com`?

Same docs, two domains. Both serve the developer portal (Redoc + Markdown content). `viva.com` is the rebranded primary; `vivawallet.com` aliases remain for backward compatibility. Either works in `WebFetch`-style operations.

---

## 10. References

- `docs/payment-api.yaml` — merchant + marketplace OpenAPI (pulled 2026-05-12)
- `docs/payment-isv-api.yaml` — ISV OpenAPI
- `references/viva-docs/md/oauth2-authentication.txt` — OAuth2 token flow
- `references/viva-docs/md/merchant-id-and-api-key.txt` — Merchant Basic credential lookup
- `references/viva-docs/md/isv-credentials.txt` — ISV + Reseller credential lookup
- `references/viva-docs/md/find-account-credentials.txt` — overview of all credentials

---

## 11. Changelog (this document)

- 2026-05-12 — initial. Covers the merchant / marketplace / ISV operational modes. Refund matrix includes Fast Refund (modern OAuth2) alongside standard refund (Basic). Rename of `LegacyBasicClient` → `BasicAuthClient` proposed. Hosts matrix §9 added covering demo vs live for all three host families plus ancillary hosts.
