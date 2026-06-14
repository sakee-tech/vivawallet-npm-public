# @sakeetech/viva-payments-core

## 0.3.0

### Breaking Changes

- **`IsvSources.createEcommerceSource` / `createPhysicalSource` now return
  `void` and require `sourceCode` as a 4-digit string.** Viva's
  `POST /api/sources` returns an empty `200` body (no `sourceCode` echoed) and
  there is no `GET /api/sources` to read an auto-assigned code back, so the
  caller must supply the code. `sourceCode` is typed `string` per Viva's
  `new_source` schema (support-confirmed 2026-06-13: send quoted, e.g.
  `"1234"`; range 1000–9999). The previous `SourceResponse` return type is
  removed. Calls are now `idempotent: true` (a duplicate code returns `409`).
  Fixes a crash where the code read `sourceCode` off the empty body (#24).
- **`FastRefundResponse` is trimmed to `{ transactionId }`.** The `eventId` and
  `amount` fields never existed in Viva's `fastrefund_success` schema.

### Bug Fixes

- `cancelOrder` / `retrieveOrder` validated `orderCode` as a string; `OrderCode`
  is `bigint`. The guard now correctly requires a positive bigint.

### Validation

- Request builders hard-fail on missing spec-required fields before the wire
  (clear error instead of an opaque Viva 4xx): `createConnectedAccount`
  (`email`, `returnUrl`, and `branding.partnerName`/`logoUrl` when `branding`
  is present), `registerWebhook` (`eventTypeId`, `url`), and non-empty
  path-param guards on the legacy `cancel`/`refund`/`retrieve` calls.

## 0.2.9

### Bug Fixes

- **Response amounts are major units, not minor.** `retrieveTransaction` and
  `refundPayment` treated Viva's major-unit response amounts (e.g. `17.96`) as if
  they were already minor units, and `BigInt(decimal)` threw on any non-integer
  amount. Amounts now convert through a new currency-aware `majorToMinor` /
  `minorUnitExponent` helper (`@sakeetech/viva-payments-core` root export), so
  decimal amounts and non-2-decimal currencies (e.g. JPY, BHD) round-trip
  correctly (#20/#4).
- **Refund and cancel now gate on the success body.** Both previously assumed a
  `200` meant success; Viva returns `200` with a failure body. They now inspect
  the body and surface a failure instead (#3).
- **`merchantId` fallback** when absent from the response (#5), and
  **`currencyCode` is coerced via `String()`** before use (#6).
- **`createOrder` enforces the Viva 30-minor-unit minimum** (#8).
- **ISV `OrderCode` int64 precision.** `bigintSafeParse` now quotes the
  `OrderCode` before `JSON.parse` so the 16-digit code is not silently rounded by
  IEEE-754 (#10).

### Features

- **`Payments.retrieveOrder(orderCode, opts?)`.** `GET /api/orders/{orderCode}` on
  the legacy host with Basic auth — there is no v2/OAuth2 equivalent (that route
  404s, same as cancel). Amounts in the body are major-unit floats with no
  currency; pass `opts.currencyCode` for non-2-decimal currencies. Requires a
  `legacyClient`. Adds the `RetrieveOrderResponse` type.

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
