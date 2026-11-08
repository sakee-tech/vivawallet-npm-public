# Migration Guide — `0.1.x` → `0.2.0`

> One page. What changes, why, and the minimum code-mod to upgrade.

---

## TL;DR

`0.2.0` introduces **operational modes**. The 90% case (single merchant) becomes the default; the existing ISV behaviour stays available behind one config line. Marketplace mode is reserved for a later release.

If you're an existing ISV consumer: **add `mode: 'isv'` to your plugin config.** Most env vars get aliases for one minor cycle. Everything else stays.

If you're a new consumer (single merchant): **install and configure as usual.** Don't set `mode`. Read the merchant-mode README section.

---

## 1. Affected packages

| Package | `0.1.x` version | `0.2.0` | Breaking? |
|---|---|---|---|
| `@sakeetech/viva-payments-core` | `0.1.0` | `0.2.0` | yes — export rename |
| `@sakeetech/medusa-payment-viva` | `0.1.0` | `0.2.0` | yes — config rename + mode flag |
| `@sakeetech/vendure-payment-viva` | `0.1.1` | `0.2.0` | yes — config rename + mode flag |

All three bump together in a single release round.

---

## 2. Breaking changes

### 2.1 `viva-payments-core`

| Before | After | Reason |
|---|---|---|
| `import { IsvPayments } from '@sakeetech/viva-payments-core/isv'` | `import { Payments } from '@sakeetech/viva-payments-core/payments'` | The same client now serves both merchant + ISV. ISV-specific behaviour moves behind a `mode` field on construction. |
| `import { LegacyBasicClient } from '@sakeetech/viva-payments-core/isv'` | `import { BasicAuthClient } from '@sakeetech/viva-payments-core/legacy'` | Viva does NOT consider this surface "legacy" — name was misleading. The new class also supports two auth variants (`'merchant'` and `'reseller'`). |
| `new IsvPayments({ client, legacyClient })` | `new Payments({ mode, http, basic, merchantId? })` | `merchantId` is optional and required only when `mode === 'isv'`. |

**`/isv` subpath** retains `IsvAccounts`, `IsvWebhooks`, plus the new `IsvSources` class for `POST /api/sources`.

### 2.2 `medusa-payment-viva` + `vendure-payment-viva`

**Config shape — discriminated union on `mode`:**

```ts
// 0.1.x — ISV implicit (only ISV mode existed)
VivaPaymentPlugin.init({
  isvClientId: '...',
  isvClientSecret: '...',
  // ...
})

// 0.2.0 — explicit mode
VivaPaymentPlugin.init({
  mode: 'isv',                   // ← NEW: explicit. Default is 'merchant'.
  clientId: '...',               // renamed from isvClientId
  clientSecret: '...',           // renamed from isvClientSecret
  // resolveMerchantId, etc. unchanged
})
```

**Env var renames** (old names accepted for `0.2.x` with a deprecation warning; removed in `0.3.0`):

| Before | After | Notes |
|---|---|---|
| `VIVA_ISV_CLIENT_ID` | `VIVA_CLIENT_ID` | Now mode-agnostic |
| `VIVA_ISV_CLIENT_SECRET` | `VIVA_CLIENT_SECRET` | Now mode-agnostic |
| `VIVA_MERCHANT_ID` | (unchanged) | Still for Basic-auth refunds |
| `VIVA_API_KEY` | (unchanged) | Still for Basic-auth refunds |
| `VIVA_WEBHOOK_VERIFICATION_KEY` | (unchanged) | Both modes use this |
| `VIVA_RESELLER_*` | (unchanged) | ISV-only (now also needed for `POST /api/sources`) |
| — | `VIVA_MODE` (NEW) | `'merchant'` (default) \| `'isv'`. Loud startup log when unset to guard against accidental mode drift. |
| — | `VIVA_SOURCE_CODE` (NEW) | Optional in merchant mode; defaults to `'Default'` |

### 2.3 Vendure — channel custom fields

| Field | `0.1.x` | `0.2.0 mode='merchant'` | `0.2.0 mode='isv'` |
|---|---|---|---|
| `vivaSourceCode` | registered | registered | registered |
| `vivaApplePayDomainVerified` | registered | registered | registered |
| `vivaAccountId` | registered | **not registered** | registered |
| `vivaMerchantId` | registered | **not registered** | registered |
| `vivaPayoutsEnabled` | registered | **not registered** | registered |

If you have data in `vivaAccountId` / `vivaMerchantId` / `vivaPayoutsEnabled` and switch to merchant mode, those columns remain in the DB but become invisible to the plugin. Drop them via migration if you want; no data loss either way (Vendure preserves unknown custom field data).

### 2.4 Admin REST endpoints (Vendure + Medusa)

| Path | Available in `0.2.0 mode='merchant'` | Available in `0.2.0 mode='isv'` |
|---|---|---|
| `POST /viva/admin/connected-accounts` | 404 | yes |
| `GET /viva/admin/connected-accounts/:id` | 404 | yes |
| `POST /viva/admin/connected-accounts/:id/reconcile` | 404 | yes |
| `POST /viva/admin/connected-accounts/:id/sources` (NEW) | 404 | yes (requires `reseller` config or 412) |
| `GET /viva/internal/auth-status` | yes | yes |
| `GET /viva/webhook/health` | yes | yes |
| `GET /viva/metrics` | yes | yes |
| `POST /viva/webhook` | yes | yes |

### 2.5 CLI behaviour

`vendure-viva-register-webhooks` / `viva-register-webhooks`:

| Mode | `--apply` behaviour |
|---|---|
| `merchant` (NEW) | Fetches verification key via `GET /api/messages/config/token`, prints URLs to register manually in Viva Self Care. Exit 0. |
| `isv` | Unchanged — calls `POST /isv/v1/webhooks` per event type. |

`--dry-run` and `--reconcile-drift` flags work in ISV mode only; in merchant mode they print "not applicable (manual setup)".

### 2.6 Error codes

Four new codes:

- `VIVA_FAST_REFUND_INELIGIBLE` — internal when `refundStrategy='fast'` and card/merchant ineligible; surfaced only when explicitly requested
- `VIVA_SOURCE_CREATION_FAILED` — `POST /api/sources` returned 4xx
- `VIVA_MODE_MISMATCH` — caller invoked ISV-only endpoint in merchant mode
- `VIVA_RESELLER_CREDENTIALS_MISSING` — source creation called without reseller block

All existing codes (`VIVA_AUTH_DOWN`, `VIVA_API_ERROR`, etc.) unchanged. See `docs/ERRORS.md`.

---

## 3. Non-breaking changes

These additions don't require any consumer action.

| What | Where |
|---|---|
| Fast Refund support (`POST /acquiring/v1/transactions/{id}:fastrefund`) | Plugin auto-uses when card is Visa/MC and merchant approved. Config: `refundStrategy?: 'auto' \| 'fast' \| 'standard'` (default `'auto'`). |
| Tracing / observability hooks landed (cumulatively since `0.1.0`) | Already wired internally; no consumer action |
| Canonical ISV API paths (`/isv/v1/accounts`, `/isv/v1/webhooks`, `/isv/v1/webhooks/token`) | Internal — was a hot-fix during `0.1.x` |
| Marketplace-mode seams reserved (not exposed) | Internal types; no public API |

---

## 4. Step-by-step upgrade

### 4.1 If you were on `0.1.x` ISV

```diff
  // vendure-config.ts (or medusa-config.ts)
  VivaPaymentPlugin.init({
+   mode: 'isv',
-   isvClientId:     process.env.VIVA_ISV_CLIENT_ID!,
-   isvClientSecret: process.env.VIVA_ISV_CLIENT_SECRET!,
+   clientId:        process.env.VIVA_CLIENT_ID!,
+   clientSecret:    process.env.VIVA_CLIENT_SECRET!,
    legacyMerchantId: process.env.VIVA_MERCHANT_ID!,
    legacyApiKey:     process.env.VIVA_API_KEY!,
    webhookVerificationKey: process.env.VIVA_WEBHOOK_VERIFICATION_KEY!,
    successUrl: '...',
    failureUrl: '...',
    // resolveMerchantId, resolveSourceCode, etc. — unchanged
  })
```

`.env`:

```diff
- VIVA_ISV_CLIENT_ID=...
- VIVA_ISV_CLIENT_SECRET=...
+ VIVA_CLIENT_ID=...
+ VIVA_CLIENT_SECRET=...
+ VIVA_MODE=isv
```

Old env names still accepted for one minor — set both for safety during the rolling deploy, then remove the old ones.

### 4.2 If you are a NEW consumer (single merchant)

```ts
// vendure-config.ts
VivaPaymentPlugin.init({
  // mode: 'merchant',  ← default, omit
  clientId:     process.env.VIVA_CLIENT_ID!,
  clientSecret: process.env.VIVA_CLIENT_SECRET!,

  // Required for refunds (both Standard and as fallback for Fast Refund)
  legacyMerchantId: process.env.VIVA_MERCHANT_ID!,
  legacyApiKey:     process.env.VIVA_API_KEY!,

  webhookVerificationKey: process.env.VIVA_WEBHOOK_VERIFICATION_KEY!,
  successUrl: 'https://your-storefront.com/order-confirmation/{orderCode}',
  failureUrl: 'https://your-storefront.com/checkout?paymentCancelled=1',

  sourceCode: 'Default',   // optional; default 'Default'
});
```

`.env`:

```
VIVA_CLIENT_ID=...
VIVA_CLIENT_SECRET=...
VIVA_MERCHANT_ID=...
VIVA_API_KEY=...
VIVA_WEBHOOK_VERIFICATION_KEY=  # leave empty until step 4
```

Setup steps:

1. **Get OAuth2 credentials** — Viva Self Care → Settings → API Access → Smart Checkout → Create client credentials.
2. **Get Basic auth credentials** — Viva Self Care → Settings → API Access → Merchant credentials.
3. **Install plugin + run migrations** (`npx vendure migrate` or Medusa equivalent).
4. **Get webhook verification key** — run `viva-register-webhooks --apply` (merchant mode prints the key + URLs).
5. **Paste the printed URLs** into Viva Self Care → Sales → API Access → Webhooks. One URL per event type (1796, 1797, 1798, 4865).
6. **Set `VIVA_WEBHOOK_VERIFICATION_KEY`** in `.env` to the printed key and restart.

---

## 5. Code-mod cheatsheet

For consumers using core directly (rare — most use only the adapters):

```ts
// 0.1.x
import { IsvPayments, LegacyBasicClient } from '@sakeetech/viva-payments-core/isv';
const payments = new IsvPayments({ client, legacyClient });

// 0.2.0
import { Payments } from '@sakeetech/viva-payments-core/payments';
import { BasicAuthClient } from '@sakeetech/viva-payments-core/legacy';
const basic = new BasicAuthClient({ authVariant: 'merchant', merchantId, apiKey, host });
const payments = new Payments({ mode: 'isv', http, basic, merchantId });
```

For consumers using only the adapter, the only required change is in plugin init (see §4.1).

---

## 6. Verifying the upgrade

After deploying `0.2.0`:

1. **Startup log** — look for `[viva] mode = <merchant|isv>` line on plugin init. If mode is wrong, abort and fix.
2. **Auth health** — `curl -H 'Authorization: Bearer <admin>' /viva/internal/auth-status` should return `token_present: true`.
3. **Webhook health** — `curl -H 'Authorization: Bearer <admin>' /viva/webhook/health` should show non-zero `events_received_24h` after first traffic.
4. **End-to-end smoke** — place a test order. Confirm:
   - `viva_transaction` row created with `status='initiated'`.
   - Customer redirected to Smart Checkout.
   - After paying with test card, webhook 1796 arrives.
   - `viva_webhook_event.processed_at` is set within ~5s.
   - `viva_transaction.status='captured'`.
   - Vendure Payment state `Settled` / Medusa Payment `captured`.

---

## 7. Rollback

If `0.2.0` misbehaves and you need to roll back:

1. Revert plugin version: `pnpm add @sakeetech/<package>@0.1.x`.
2. Revert config:
   - Restore `isvClientId` / `isvClientSecret`.
   - Remove the `mode` field.
3. Restore old env var names (the old plugin doesn't know `VIVA_CLIENT_ID`).
4. No DB migrations need to be rolled back — the `viva_transaction` + `viva_webhook_event` schemas are unchanged across `0.1.x` ↔ `0.2.0`.

Roll-forward is preferred — open an issue with the failure mode if rollback is needed.

---

## 8. What's NOT in `0.2.0`

Out of scope for this release:

- Marketplace mode (reserved as a config-union slot only; no code shipped)
- Pre-auth-only flow
- Subscriptions / recurring payments
- Native Apple Pay domain registration via API (Viva does not expose this)
- AdminUiExtension / Medusa admin UI

---

## 9. Support

- Bug in upgrade path: open issue with the diff between your old and new config + plugin startup log.
- Documentation gaps in this guide: PRs welcome.

---

## 10. Changelog (this document)

- 2026-05-12 — initial. Pre-release migration guide. Will be finalized at release time with the as-built env var names + verified rollback path.
