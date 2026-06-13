# @sakeetech/viva-payments-core

## 0.2.8

### Bug Fixes

- **`Payments.cancelOrder` now targets the legacy host with Basic auth.** It
  previously called `DELETE /checkout/v2/orders/{orderCode}` on the OAuth2 API
  host — a route that does not exist (verified live, 2026-06-13: every order,
  including `GET`-by-code, returns an empty `404`). Cancels silently fell through
  the "free the Payment anyway" path: the order was never voided and lingered
  until `paymentTimeout`. Cancel now uses `DELETE /api/orders/{orderCode}` on the
  legacy host (`demo.vivapayments.com` / `www.vivapayments.com`) with Basic auth —
  the same transport as `refundPayment`. Merchant mode uses the Merchant Basic
  `legacyClient`; ISV mode passes a Reseller-variant client per call
  (`base64(ResellerId:ConnectedMerchantId:ResellerApiKey)`). `cancelOrder` now
  **requires** a `legacyClient` (throws `VivaValidationError` otherwise), and the
  dead `merchantId`-query / OAuth2 401-fallback path is removed. Both legs verified
  `200 Success` against live demo; re-cancel is idempotent. See
  `docs/internal/viva-cancel-probes/`.

> Note: 0.2.5–0.2.7 were released without CHANGELOG entries; this entry resumes
> the log at the current version.

## 0.2.4

### Bug Fixes

- **`Payments.createOrder` no longer sends the non-existent `successUrl` / `failureUrl` fields** (sakee-tech/vivawallet-npm-public#15).
  Viva's Smart Checkout create-order body (`Create_New_Payment_Order_v2_schema`)
  has **no** generic success/failure redirect field — only `urlFail` + `stateId=1`,
  which is an **expiry-only** redirect. The post-payment redirect target is a
  property of the payment **source** (`pathSuccess` / `pathFail`, set via
  `POST /api/sources`), not of an individual order. The client was writing
  `successUrl` / `failureUrl` onto the wire body, where Viva silently dropped them
  — dead fields that made the adapter config look load-bearing when it was inert.
  They are no longer emitted. The `successUrl` / `failureUrl` properties remain on
  `CreateOrderRequest` (now `@deprecated`) for source-compatibility but are ignored
  by `createOrder`. No behavioural change at Viva — the fields never had any effect.

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
