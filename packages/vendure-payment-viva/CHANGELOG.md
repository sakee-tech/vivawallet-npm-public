# @sakeetech/vendure-payment-viva

## 0.2.8

### Bug Fixes

- **Reconcile the `viva_transaction` row's `paymentId` proxy to the real Payment.id** (sakee-tech/vivawallet-npm-public#13).
  `createPayment` writes the row keyed on `order.id` because Vendure assigns the
  real `Payment.id` only AFTER the handler returns — and that proxy was never
  reconciled. Every reader keyed on the real `Payment.id`, so `cancelPayment`
  (resolver + handler), `settlePayment`, `createRefund`, and the webhook settle
  path all missed in production; they only worked when `order.id === payment.id`
  (true in fresh test DBs, false once orders and payments diverge — e.g. after any
  retry). The result: `cancelPayment` returned `VIVA_PAYMENT_NOT_CANCELLABLE` and
  the storefront retry-after-failure path stayed broken even with the 0.2.7 fix,
  and the 1796 webhook could not resolve the payment to settle.
  The viva `PaymentProcess.onTransitionStart` now reconciles the row — located by
  its globally-unique `vivaOrderCode` (no id-collision) — during the create-time
  transition where the real `Payment.id` is available. It runs inside the
  createPayment transaction, never blocks the payment on failure (logged and
  swallowed), and repairs every reader with no change to their call sites. Retry
  semantics are preserved: because the prior attempt's row is now keyed by its own
  `Payment.id`, a retry mints a fresh Viva order instead of returning the stale,
  cancelled checkout.

## 0.2.7

### Bug Fixes

- **Send customer identity + merchant reference on the Viva createOrder request** (sakee-tech/vivawallet-npm-public#11).
  `createPayment` previously sent only `amount`, `currencyCode`, `sourceCode`, and
  (ISV) `isvAmount` — so the Viva dashboard transaction was never tagged with the
  Vendure order code and the Smart Checkout page showed a blank description with no
  prefilled customer fields. It now forwards, from the order already in scope (its
  `customer` relation is loaded by Vendure):
    - `merchantTrns` ← `order.code` (merchant-facing, echoed in webhooks as
      `EventData.MerchantTrns` for reconciliation),
    - `customerTrns` ← the new optional `resolveCustomerTrns(order, ctx)` option
      (default `Order <code>`) — shown on Smart Checkout + the bank statement,
    - `customerEmail` / `customerFullName` / `customerPhone` ← `order.customer`
      (used for the Viva receipt, 3DS hint, and checkout prefill).
  All customer fields are conditionally included (omitted when absent) and the
  references are length-clamped (`merchantTrns` ≤50, `customerTrns` ≤255,
  `customerFullName` ≤100). The core client maps the typed names to the Viva wire
  body (`customerEmail → email`, `customerPhone → phone`, `customerFullName → fullName`).

- **`cancelPayment` now transitions the Vendure Payment to Cancelled** (sakee-tech/vivawallet-npm-public#12).
  The shop-API `cancelPayment` resolver called the handler's cancel fn directly and
  transitioned only the Order, leaving the Vendure Payment in `Created`. Vendure's
  `totalCoveredByPayments()` counts every payment except `Error`/`Declined`/`Cancelled`,
  so the lingering `Created` payment made the order's outstanding amount 0 and blocked
  retry-after-failed-payment (the ISV guard then threw "isvAmount must be strictly less
  than order amount (0)"). The resolver now cancels via `PaymentService.cancelPayment`,
  which voids Viva (through our handler) AND transitions the Payment `Created → Cancelled`,
  so a subsequent `addPaymentToOrder` sees the full outstanding amount. Existing Viva
  error mapping (VIVA_API_ERROR / VIVA_AUTH_DOWN) is preserved.

## 0.2.6

### Bug Fixes

- **Register a custom `PaymentProcess` permitting the `Created → Created` self-transition** (sakee-tech/vivawallet-npm-public#10).
  `createPayment` returns `state: 'Created'` (its redirect-first D3 contract), but
  Vendure core's `PaymentService.createPayment` always persists the new Payment in
  `Created` and then immediately calls `transition(payment, 'Created')`. The default
  payment process only allows `Created → [Authorized, Settled, Declined, Error,
  Cancelled]`, so the self-transition was rejected with
  `Cannot transition Payment from "Created" to "Created"` → `addPaymentToOrder` 500
  → the storefront bounced to `/?paymentInProgress=1` and no Viva order was ever
  surfaced. Every payment was blocked. The plugin now registers `vivaPaymentProcess`
  via `config.paymentOptions.customPaymentProcess`, additively legalising the
  self-transition (the default outgoing transitions are preserved; `onTransitionEnd`'s
  `orderTotalIsCovered(order,'Settled')` is `false` while the payment is `Created`, so
  no spurious order transition fires). Unlike the official Stripe/Mollie plugins —
  which sidestep this by never returning `Created` and minting the redirect in a
  separate mutation — Viva is redirect-first by design (the Viva `orderCode` is the
  redirect ref), so permitting the self-transition is the minimal in-contract fix.
  Guarded by a real-Vendure-boot regression test asserting the live FSM allows the
  `Created → Created` transition (the handler-seam unit tests bypassed the FSM, which
  is why this stayed latent).

## 0.2.5

### Bug Fixes

- **Pick up the `viva-payments-core@0.2.3` create-order `orderCode` fix** (sakee-tech/vivawallet-npm-public#9).
  The core adapter discarded Viva's `orderCode` on every real response (it read
  PascalCase `OrderCode` while Viva returns lowercase `orderCode`), so `createPayment`
  could never obtain an order code and no live ISV Smart Checkout could complete —
  Viva had created the order (HTTP 200) but the plugin couldn't build the redirect.
  Fixed in core 0.2.3; this release bumps the pinned dependency. Plugin
  `createPayment` mocks were corrected to Viva's real lowercase response shape.

## 0.2.4

### Bug Fixes

- **Transmit the ISV platform fee (`isvAmount`) in the Viva createOrder call** (sakee-tech/vivawallet-npm-public#7).
  `createPayment` resolved, guarded, and stored `isvAmount` but omitted it from
  the Viva `createOrder` request body, so the commission split silently never
  happened — the merchant received the full amount and the ISV platform got
  nothing. The fee is now sent (and omitted when `0` to avoid tripping Viva's
  documented `minimum` of `30` on a no-commission order). Per the Viva
  create-order API, `isvAmount` is included in — not added to — `amount`, so the
  merchant is paid `amount − isvAmount`. The underlying `Payments` client emits
  it only in ISV mode and strips it in merchant mode.
- **Guard a missing `orderCode` from Viva's createOrder response** (sakee-tech/vivawallet-npm-public#8).
  An anomalous response without an `orderCode` previously crashed on an
  unguarded `.toString()`, surfacing to the storefront as an opaque 500. It now
  logs the raw payload and throws a mappable `VIVA_API_ERROR`.

## 0.2.3

### Bug Fixes

- **Add `PluginCommonModule` to the plugin's `imports`** (sakee-tech/vivawallet-npm-public#5).
  Was `imports: []`, so NestJS could not resolve the core providers the plugin's
  own services inject (`TransactionalConnection`, `OrderService`, `PaymentService`
  via `StateMachineService`; `ConnectedAccountsService`; webhook handler; resolver),
  crashing the server on bootstrap. `PluginCommonModule` exposes those core
  providers to the plugin's injector scope.
- **`CancelPaymentError.errorCode` is now `ErrorCode!`** (sakee-tech/vivawallet-npm-public#6).
  Was `String!`, which violates Vendure's `ErrorResult` interface (`errorCode:
  ErrorCode!`) and failed the GraphQL schema build. The plugin's granular reason
  codes (`VIVA_PAYMENT_NOT_CANCELLABLE`, `AUTHORIZATION_FAILED`, `VIVA_*`) are
  registered via `extend enum ErrorCode` so they remain valid enum members at
  runtime.

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
