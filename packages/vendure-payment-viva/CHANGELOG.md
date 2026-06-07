# @sakeetech/vendure-payment-viva

## 0.2.2

### Packaging

- **Ship CommonJS instead of ESM-only** (sakee-tech/vivawallet-npm-public#3).
  Vendure servers are CommonJS by default (`@vendure/core` is `type: commonjs`);
  the previous ESM-only build could not be statically imported from a CJS
  `vendure-config.ts` under `node16`/`nodenext` (TS1479), forcing a dynamic
  `import()` workaround. Now built as CommonJS — import the plugin normally.
- **Remove dead `bullmq` dependency** (sakee-tech/vivawallet-npm-public#1).
  `bullmq` was in `dependencies` but never imported; it only appeared in
  comments describing the recommended deployment. BullMQ remains the
  recommended `JobQueueStrategy` (docs only), not a hard dependency.
- CLI shebang fixed to `#!/usr/bin/env node` (was `tsx`) so the published
  `vendure-viva-register-webhooks` bin runs without a dev-only tool.

### Docs

- Prerequisites reworded: the webhook flow needs a **durable** `JobQueueStrategy`
  (the real constraint — in-memory loses jobs on restart, stranding a payment
  in `Created`), with BullMQ as the recommended implementation rather than a
  hard requirement (sakee-tech/vivawallet-npm-public#2).

## 0.2.1

### Security

- **CSO Finding #1 (CRITICAL — defensive parity):** the 1796 handler
  already looked up the local row by `vivaTransaction.orderCode` (from
  Viva's authenticated re-fetch) — the canonical Viva WooCommerce
  pattern. Added a load-bearing comment at the lookup site so future
  refactors don't regress to using the attacker-controlled envelope
  `OrderCode` without an explicit cross-check.
- **CSO Finding #2 (HIGH):** webhook source-IP extraction now walks
  `X-Forwarded-For` from the rightmost end via the new
  `extractClientIp` core helper. New plugin option `trustedProxyDepth`
  (default `0`) tells the receiver how many trailing X-F-F hops are
  set by operator-controlled proxies. The previous "trust leftmost
  X-F-F, fall back to X-Real-IP" behaviour was vulnerable to header
  injection — see README §"Webhook firewall configuration" for the
  upgrade guidance, including nginx/Cloudflare/ALB snippets and the
  Viva published IP list.

### Added

- New plugin option `trustedProxyDepth: number`.

### Changed

- `getSourceIp(req)` signature is now `getSourceIp(req, trustedProxyDepth = 0)`.
  Existing call sites that omit the depth get socket-only behaviour
  (the new safe default). `X-Real-IP` is no longer consulted —
  configure `trustedProxyDepth: 1` instead.

See `docs/TODO-CSO.md` for the full audit, exploit walkthroughs, and
provenance.

## 0.2.0

### Breaking changes

- `VivaPluginOptions` is now a discriminated union: `VivaMerchantOptions | VivaIsvOptions`.
- Field renames: `isvClientId` → `clientId`, `isvClientSecret` → `clientSecret`. The old names are still accepted with a one-time deprecation warning for one minor and will be removed in `0.3.0`.

### Added

- `mode: 'merchant' | 'isv'` plugin option. Default is `'merchant'` with a one-time startup warning. ISV mode is auto-detected when either `resolveMerchantId` or `reseller` is passed.
- Full merchant-mode payment handler surface: `createPayment`, `settlePayment`, `cancelPayment`, `createRefund`.
- `refundStrategy: 'auto' | 'fast' | 'standard'` plugin option. `auto` automatically falls back from Fast Refund to Standard refund on `403` responses.
- `vendure-viva-register-webhooks` CLI gained merchant-mode support.
- New admin REST endpoint `POST /viva/admin/connected-accounts/:id/sources` (ISV-only) wrapping `IsvSources` from core.
- Webhook handler now no-ops on event types `8193`/`8194` (account connect/disconnect) in merchant mode — events are logged and acknowledged so Viva does not retry.
- Mode-aware channel resolution in the webhook handler: `ChannelService.getDefaultChannel` is used for merchant mode; merchant-id lookup remains for ISV mode.
- New error codes: `VIVA_RESELLER_CREDENTIALS_MISSING`, `VIVA_SOURCE_CREATION_FAILED`.
- README updated for multi-mode install paths.

### Changed

- Channel custom fields are mode-gated: `vivaAccountId`, `vivaMerchantId`, and `vivaPayoutsEnabled` are registered only in ISV mode. `vivaSourceCode` and `vivaApplePayDomainVerified` are registered in both modes.
- Channel custom field readers (`vivaPayoutsEnabled` etc.) are guarded behind `mode === 'isv'` checks at the read site to avoid undefined-field access in merchant mode.

### Tests

- Test suite expanded from 233 to 285 tests covering merchant handlers, channel-field gating, refund strategy fallback, and the new sources admin route.

### Unreleased 0.1.1 fixes (folded into 0.2.0)

The `0.1.1` `package.json` bump shipped without a corresponding CHANGELOG entry. Those fixes are rolled into `0.2.0`:

- ISV probe corrections: canonical paths locked to `/isv/v1/accounts`, `/isv/v1/webhooks`, `/isv/v1/webhooks/token`.
- Standard refund path wired via `BasicAuthClient` (was missing in `0.1.0`).
- Observability hooks: tracing wired through plugin entrypoints.

### See also

- Upgrade guide: [`docs/MIGRATION-0.1-to-0.2.md`](../../docs/MIGRATION-0.1-to-0.2.md)
- Implementation plan: [`docs/plans/multi-mode-v0.md`](../../docs/plans/multi-mode-v0.md)

## 0.1.0

### Minor Changes

- Initial release of Viva Wallet plugin: core SDK, Medusa adapter, Vendure placeholder.

### Patch Changes

- Updated dependencies
  - @sakeetech/viva-payments-core@0.1.0
