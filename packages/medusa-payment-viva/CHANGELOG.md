# @sakeetech/medusa-payment-viva

## 0.2.6

### Bug Fixes

- **Cancel now actually voids the Viva order.** Via the core `cancelOrder` fix,
  cancel routes to `DELETE /api/orders/{orderCode}` on the legacy host with Basic
  auth (the OAuth2 `/checkout/v2/orders/{oc}` route 404s). ISV mode builds a
  Reseller-variant legacy client scoped to the connected merchant per call
  (mirroring the Standard refund path) and now **requires reseller credentials**
  (`VIVA_RESELLER_ID` / `VIVA_RESELLER_API_KEY`) for cancel; merchant mode uses the
  construction-time Merchant Basic client.

### Dependencies

- Bumps `@sakeetech/viva-payments-core` to `0.2.8` (cancelOrder legacy-host fix).

> Note: 0.2.3–0.2.5 were released without CHANGELOG entries; this entry resumes
> the log at the current version.

## 0.2.2

### Packaging

- **Ship CommonJS instead of ESM-only** (sakee-tech/vivawallet-npm-public#3).
  Medusa v2 servers are CommonJS (`@medusajs/framework` is CJS); the previous
  ESM-only build could not be statically imported under `node16`/`nodenext`
  (TS1479). Now built as CommonJS (`type: commonjs`, `exports` resolve via
  `default`). No API changes.
- The `viva-register-webhooks` CLI no longer uses top-level `await` (illegal in
  CommonJS) — wrapped in an async IIFE.

## 0.2.1

### Security

- **CSO Finding #1 (CRITICAL):** webhook workflow now cross-checks
  `live.orderCode` (from Viva's authenticated `retrieveTransaction` call)
  against the envelope `OrderCode` before any state mutation, and uses
  the verified value for the local `SELECT FOR UPDATE` lookup. An
  attacker holding any real paid Viva `TransactionId` could previously
  forge a webhook claiming a victim's `OrderCode`; the workflow would
  apply the live transaction's status to the victim's row.
- **CSO Finding #2 (HIGH):** webhook source-IP extraction now walks
  `X-Forwarded-For` from the rightmost end. New env var
  `VIVA_TRUSTED_PROXY_DEPTH` (default `0`) tells the receiver how many
  trailing X-F-F hops it should trust. The previous "trust leftmost
  X-F-F" behaviour was vulnerable to header injection — see README
  §"Webhook firewall configuration" for the upgrade guidance,
  including nginx/Cloudflare/ALB snippets and the Viva published
  IP list.
- **CSO Finding #3 (MEDIUM, dormant):** removed the HMAC code path that
  reused `VIVA_WEBHOOK_VERIFICATION_KEY` (a public value) as the HMAC
  secret. The plugin never subscribed to event 7936, so this is a
  no-op operationally; if 7936 is added in the future, route a
  dedicated `VIVA_WEBHOOK_HMAC_SECRET`.

### Added

- New metric `viva_webhook_ordercode_mismatch_total{event_type_id}`.
- New env var `VIVA_TRUSTED_PROXY_DEPTH`.

See `docs/TODO-CSO.md` for the full audit, exploit walkthroughs, and
provenance.

## 0.2.0

### Breaking changes

- `VivaPluginConfig` is now a discriminated union: `VivaMerchantConfig | VivaIsvConfig`. Field renames at the top level:
  - `isvClientId` → `clientId`
  - `isvClientSecret` → `clientSecret`
  - The previously nested `isvCredentials.*` fields are now flattened onto the ISV config variant.
- Env var renames: `VIVA_ISV_CLIENT_ID` → `VIVA_CLIENT_ID`, `VIVA_ISV_CLIENT_SECRET` → `VIVA_CLIENT_SECRET`. The old names are still accepted with a one-time deprecation warning for one minor and will be removed in `0.3.0`.

### Added

- `mode: 'merchant' | 'isv'` config field. Default is `'merchant'` with a one-time startup warning when the field is unset. ISV mode is auto-detected when any `VIVA_RESELLER_*` env var is set.
- Full merchant-mode payment handler surface: `initiate`, `authorize`, `capture`, `refund`, `cancel`, `retrieve`, `getPaymentStatus`, `update`, `delete`.
- `refundStrategy: 'auto' | 'fast' | 'standard'` config field plus `VIVA_REFUND_STRATEGY` env var. `auto` automatically falls back from Fast Refund to Standard refund on `403` responses.
- Mode-conditional surface: webhook event types `8193`/`8194` (account connect/disconnect) are no-op in merchant mode; admin REST routes for connected accounts return `404` outside ISV mode.
- New admin endpoint `POST /viva/admin/connected-accounts/:id/sources` (ISV-only) wrapping `IsvSources` from core with Reseller Basic auth.
- `viva-register-webhooks` CLI gained merchant-mode support: it fetches the verification key via `BasicAuthClient.fetchWebhookVerificationKey()` and prints manual setup instructions for the Viva dashboard.
- Shared admin helpers extracted: `_mode-gate.ts` (mode guard for routes) and `_admin-auth.ts` (auth helper).
- New `VIVA_SOURCE_CODE` and `VIVA_REFUND_STRATEGY` env vars wired through config loading.
- README written from scratch (was previously missing) covering merchant and ISV install paths.

### Changed

- Webhook failure path now records an error envelope on the row and bumps `retry_count`, so retries are observable from the DB.

### Database

- `viva_webhook_event` table: added `error` (text, nullable) and `retry_count` (int, default `0`) columns.
- `viva_transaction.viva_merchant_id` is now nullable. Merchant-mode rows have no merchant ID, since the merchant is the integrator themselves.

### Tests

- Test suite expanded from ~98 to 157 tests covering merchant handlers, mode gating, refund strategy fallback, and the new sources admin route.

### See also

- Upgrade guide: [`docs/MIGRATION-0.1-to-0.2.md`](../../docs/MIGRATION-0.1-to-0.2.md)
- Implementation plan: [`docs/plans/multi-mode-v0.md`](../../docs/plans/multi-mode-v0.md)

## 0.1.0

### Minor Changes

- Initial release of Viva Wallet plugin: core SDK, Medusa adapter, Vendure placeholder.

### Patch Changes

- Updated dependencies
  - @sakeetech/viva-payments-core@0.1.0
