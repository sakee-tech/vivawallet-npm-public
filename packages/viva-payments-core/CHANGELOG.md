# @sakeetech/viva-payments-core

## 0.2.3

### Bug Fixes

- **`Payments.createOrder` now reads Viva's `orderCode` regardless of key casing** (sakee-tech/vivawallet-npm-public#9).
  Viva's `checkout/v2` create-order response returns the code as lowercase
  `orderCode`, but the adapter read PascalCase `raw.OrderCode`, so it returned
  `{ orderCode: undefined }` for every real response — silently discarding a code
  Viva *had* issued (HTTP 200, order created), orphaning the order on Viva's side
  and making every downstream payment fail. Now reads `raw.orderCode ?? raw.OrderCode`,
  mirroring `retrieveTransaction`'s existing defensive read. (`cancelOrder` stays
  PascalCase — the DELETE-order envelope is PascalCase per the Viva API.)

## 0.2.2

### Packaging

- **Ship CommonJS instead of ESM-only.** The package was `type: module` with
  an `import`-only `exports` map, which a CommonJS consumer (the default for
  Vendure and Medusa servers) cannot statically import under `node16`/`nodenext`
  resolution (TS1479). Now built as CommonJS (`type: commonjs`, `exports`
  resolve via `default`, `verbatimModuleSyntax` disabled). No API changes.
  See sakee-tech/vivawallet-npm-public#3.

## 0.2.1

### Added

- `extractClientIp(req, trustedProxyDepth)` exported from
  `@sakeetech/viva-payments-core/webhooks`. Walks `X-Forwarded-For`
  from the rightmost end, counting back exactly `trustedProxyDepth`
  hops; falls back to `req.socket.remoteAddress` when the chain is
  shorter than configured. Supports IPv6-mapped IPv4 and bracketed
  IPv6 with optional port suffix.

  Companion to CSO Finding #2 (HIGH) in the adapters. The previous
  "leftmost X-F-F" pattern used by both adapters was vulnerable to
  header injection on any deployment where the upstream proxy appends
  to X-F-F rather than stripping incoming values (nginx default, ALB,
  Fly.io, Railway, Render).

See `docs/TODO-CSO.md` for the full audit and provenance.

## 0.2.0

### Breaking changes

- `IsvPayments` renamed to `Payments` and moved to the `/payments` subpath export. A deprecated `IsvPayments` alias is retained for one minor and will be removed in `0.3.0`.
- `LegacyBasicClient` renamed to `BasicAuthClient` and moved to the `/legacy` subpath export. A deprecated `LegacyBasicClient` alias is retained for one minor and will be removed in `0.3.0`.

### Added

- `mode: 'merchant' | 'isv'` discriminator on the `Payments` constructor. The URL builder branches per mode so merchant-mode callers hit the standard Viva paths and ISV-mode callers hit `/isv/v1/*`.
- `BasicAuthClient` gained an `authVariant: 'merchant' | 'reseller'` option to support the `POST /api/sources` endpoint, which requires Reseller Basic auth rather than merchant Basic auth.
- `FastRefundClient` wrapping `POST /acquiring/v1/transactions/{id}:fastrefund` with OAuth2 acquiring scopes.
- `resolveRefundStrategy(strategy, ctx)` — pure decision function used by both adapters. Visa, Mastercard and Maestro transactions are eligible for Fast Refund; other card schemes fall through to Standard refund.
- `IsvSources` class wrapping `POST /api/sources` for ecommerce and physical source creation in ISV mode.
- `cardType: string` normalized field on the `Payments.retrieveTransaction` response, derived from the numeric `cardTypeId` returned by the Viva API.
- `BasicAuthClient.fetchWebhookVerificationKey()` — merchant-mode helper for webhook setup that retrieves the verification key the merchant must paste back into the Viva dashboard.
- New `VivaModeMismatchError` (`code: 'VIVA_MODE_MISMATCH'`) thrown when ISV-only or merchant-only APIs are called against the wrong mode.
- Subpath exports added: `./payments`, `./legacy`, `./refunds`.

### Changed

- Canonical ISV API paths confirmed and locked down against the sandbox probe: `/isv/v1/accounts`, `/isv/v1/webhooks`, `/isv/v1/webhooks/token`.

### Tests

- Test suite expanded from ~113 to 242 tests covering both modes, Fast Refund eligibility, sources creation, and webhook verification flows.

### See also

- Upgrade guide: [`docs/MIGRATION-0.1-to-0.2.md`](../../docs/MIGRATION-0.1-to-0.2.md)
- Implementation plan: [`docs/plans/multi-mode-v0.md`](../../docs/plans/multi-mode-v0.md)

## 0.1.0

### Minor Changes

- Initial release of Viva Wallet plugin: core SDK, Medusa adapter, Vendure placeholder.
