# @sakeetech/vendure-payment-viva

## 0.4.0

### Features

- **New Shop-API query `orderByVivaReturn(vivaOrderCode: String!): Order` (#28).**
  After an off-site Smart Checkout payment, Viva's ISV redirect lands on the
  source's success/fail URL carrying only `?s=<vivaOrderCode>` and
  `?t=<transactionId>` — neither is the Vendure order code, so a storefront had
  no first-party way to turn the return into an order and render the
  confirmation. Integrators were forced to stash the order code in a cross-site
  cookie that drops under Safari/iOS ITP, intermittently stranding the customer
  with an empty cart. The plugin now does the one indexed join it alone owns —
  `viva_transaction.vivaOrderCode` (unique index `idx_viva_transaction_order_code`)
  → `paymentId` → `Payment` → `Order` — with no ISV API call and no credentials.
  The query is **owner-scoped** exactly like `cancelPayment` (active customer or
  active anonymous order) and returns `null` when the code is unknown or not
  owned by the caller, so `?s=` can't be enumerated to leak other orders. This is
  the Viva-shaped equivalent of Mollie's order-code-in-redirect (Viva's ISV
  redirect is per-source, so `?s=` + the plugin's table is the join key).

## 0.3.4

### Bug Fixes

- **The cancel brick is fixed at its root: cancellability now keys off the
  authoritative Vendure `Payment.state`, never the `viva_transaction` row (#27).**
  The row is an audit/correlation record written by several independent paths
  (createPayment, settlePayment, the webhook worker, cancelPayment) and *will*
  diverge from the Vendure Payment — a settle webhook stamps it `captured` (#26),
  a half-applied cancel stamps it `cancelled` (#27) — while the Payment is still
  `Created`. Every cancel brick to date was a guard that trusted the ROW and so
  refused forever, leaving the `Created` payment counting in
  `totalCoveredByPayments()` and bricking every retry on `isvAmountTooHigh(_, 0)`.
  `util/cancel-guard.ts` now exposes `classifyCancel(paymentState)` →
  `proceed` | `refuse-paid` | `already-done`, shared by the Shop-API resolver and
  the handler so they can't drift: `Created`/`Authorized` is always cancellable
  regardless of the row; `Settled` is refused (use a refund); a Payment already
  `Cancelled`/`Declined`/`Error` returns the Order idempotently, never an error.
- **`cancelPayment` is now atomic (`@Transaction()`).** Vendure's
  `PaymentService.cancelPayment` calls our handler first (committing the
  `viva_transaction` row-cancel) and then transitions the Payment in a *separate*
  `withTransaction`. Without an enclosing `@Transaction()` on the resolver those
  were two independent commits, so the storefront's concurrent
  `?paymentCancelled=1` cancel-return renders could commit `row=cancelled` while
  the Payment transition failed to persist — the permanent
  `row=cancelled / payment=Created` split. The resolver is now
  `@Transaction() @Mutation()` (matching Vendure's own payment mutations), so the
  row-write and the `Created→Cancelled` transition commit together or roll back
  together. Concurrent duplicate calls now self-heal to an idempotent success.
- **Real-Viva coverage.** Added a Playwright-free live test
  (`viva-payments-core` `test/live/cancel-order.live.test.ts`) that mints a fresh
  ISV order against demo Viva and confirms `cancelOrder` succeeds and is
  **idempotent** (re-void → 200) — the property the cancel self-heal depends on.
- **Test seam closed.** The full-stack `boots-in-vendure` flow test (live
  `@Transaction` interceptor + real DB) and the resolver unit tests that had
  *green-lit* the brick (asserting a `cancelled` row → refused) now assert the
  self-heal.

## 0.3.3

### Bug Fixes

- **The #26 cancel reconcile was dead code behind the Shop-API resolver's
  pre-guard (0.3.2 regression).** 0.3.2 added the captured/unsettled reconcile to
  the payment-method handler's `cancelPayment`, but the Shop-API resolver runs
  its OWN row-level terminal guard first (Step 6) and refused the cancel on a
  `captured` row before `PaymentService.cancelPayment` — the only path that
  invokes the handler reconcile — was ever called. So on the real
  `?paymentCancelled=1` storefront flow the reconcile never executed and the
  brick (`isvAmountTooHigh(99, 0)`) was identical to 0.3.1. Both layers now
  share a single `shouldRefuseCancel()` predicate (`util/cancel-guard.ts`), so a
  `captured` row whose Payment is not `Settled` falls through to the handler in
  both, and they can never drift again. Every other terminal status is still
  refused.
- **Test seam closed.** The regression shipped green because no test drove the
  resolver and handler together: handler tests called `PaymentService.cancelPayment`
  directly (skipping the resolver pre-guard) and the resolver unit test mocked
  `PaymentService.cancelPayment` (skipping the handler). A full-stack matrix now
  drives the real Shop-API resolver → `PaymentService` → handler → Vendure FSM +
  DB for every cancel case (baseline free, captured-but-not-captured → freed,
  captured-and-confirmed → settled/never-voided, genuinely-terminal → refused,
  Viva-void-fails → still freed). The release scripts (`release`, `release:next`)
  now run this booted suite with `VIVA_REQUIRE_PG=1` — an unreachable Postgres is
  a hard failure, not a silent skip, so the whole flow runs before every publish.

## 0.3.2

### Bug Fixes

- **A declined first payment no longer permanently bricks retry via a
  captured/unsettled desync (#26).** A `viva_transaction` row could be marked
  `captured` while its Vendure `Payment` stayed in `Created` — either because a
  1796 settlement webhook landed on an order already `PaymentSettled` by a
  sibling payment (the idempotent no-op still stamped the row), or because a
  capture genuinely happened that Vendure never advanced. `cancelPayment` then
  refused the void (`VIVA_PAYMENT_NOT_CANCELLABLE: "terminal state: captured"`),
  so the `Created` payment kept counting in `totalCoveredByPayments()`, the
  retry's `amountToPay` dropped to 0, and `createPayment` threw
  `isvAmountTooHigh(_, 0)` with no Shop-API recovery path. Two fixes: the 1796
  handler now only marks a row `captured` when **that** payment actually reached
  `Settled` (a sibling settle no longer mis-marks it); and `cancelPayment`
  re-verifies the transaction with Viva on a captured/unsettled mismatch —
  settling the Payment when Viva confirms the capture (the order completes), or
  freeing it for retry when Viva does not (the row was mis-marked). A transient
  verify failure is surfaced as retryable rather than bricking.

## 0.3.1

### Bug Fixes

- **Retry after a declined/cancelled payment no longer reopens the dead Viva
  checkout (#25).** `createPayment` reused a cached redirect URL gated solely on
  a time-based `expiresAt` (introduced in 0.2.9), never on the Viva order's
  actual state. A Viva Payment Order is a single-use payment intent — its
  `StateId` is a one-shot lifecycle (`Pending → Expired/Canceled/Paid`) and it
  is auto-cancelled once `paymentTimeout` elapses — so after a decline or
  cancel, the still-"live"-by-the-clock order was handed back and Viva's hosted
  checkout opened directly on its failure page (`/web2/fail`), leaving the
  customer unable to pay. The handler now mints a **fresh** Viva order on every
  `createPayment` (the Vendure Mollie model) and never reuses one. The local
  `viva_transaction` row is no longer a reuse cache — it is kept purely as the
  `vivaOrderCode → paymentId` correlation record the settlement webhook resolves
  (`findByVivaOrderCode`), and is overwritten with the newest order code on each
  mint. The `expiresAt`/skew machinery from 0.2.9 is removed.

## 0.3.0

### Bug Fixes

- **Source creation no longer crashes / now persists the code (#24).**
  `AdminSourcesController` previously read `sourceCode` from the
  `createEcommerceSource` response — but Viva returns an empty `200` body, so
  that was `undefined`, producing an NPE surfaced as an opaque
  `500 VIVA_INTERNAL_ERROR` and never persisting `vivaSourceCode`. The
  controller now requires `sourceCode` in the request, normalizes a number or
  string to a quoted 4-digit string for the wire, and persists the
  caller-supplied code. The HTTP API stays backward-compatible (a numeric
  `sourceCode` is still accepted).

### Dependencies

- Requires `@sakeetech/viva-payments-core@0.3.0` (breaking `IsvSources` /
  `FastRefundResponse` contract changes).

## 0.2.17

### Bug Fixes

- **ISV onboarding now persists `vivaSourceCode` and assigns the `viva`
  PaymentMethod (#22).** After a successful **ecommerce** source create,
  `AdminSourcesController` resolves the channel by `vivaAccountId` and writes the
  source code back to the channel via `ConnectedAccountsService.writeSourceCode`,
  then assigns the global `viva` PaymentMethod via `assignVivaPaymentMethod`.
  Previously the controller returned the source code but never persisted it, so a
  fully-onboarded channel stayed on the `"Default"` source code and exposed no
  Viva option at checkout — forcing host apps to re-implement the write-back
  against `core`.
  - The numeric Viva `sourceCode` is **`String()`-coerced** before it is written
    into the string-typed `vivaSourceCode` field (`createOrder` sends `sourceCode`
    as a string).
  - The PaymentMethod is looked up by handler code and **skipped gracefully**
    (logged, no throw) when the host has not created it yet.
  - **Physical (POS) sources are not persisted** — they are not the web checkout
    source. Persistence is best-effort: the source already exists at Viva, so a
    write-back failure is logged and the `201` is still returned.

  `vivaAccountId` / `vivaMerchantId` / `vivaPayoutsEnabled` were already persisted
  by the onboarding controller and webhook 8194 handler;
  `vivaApplePayDomainVerified` remains a deliberate manual ops-tracking field.

## 0.2.16

### Bug Fixes

- **Webhook handler no longer trusts the envelope `OrderCode`.** The 1798/4865
  webhook handler re-fetches transaction state via the authenticated
  `retrieveTransaction` call before acting, instead of trusting the
  attacker-controllable webhook envelope (#2, security).
- **`ConnectedAccountId`, not `AccountId`** when matching the connected merchant
  (#1); **verification key read from capital `Key`** in the Viva response (#11);
  **`retryCount` seeded from the job, not the envelope** (#12).

### Dependencies

- Bumps `@sakeetech/viva-payments-core` to `0.2.9` (amount major→minor,
  `retrieveOrder`, success-body gates).

## 0.2.15

### Bug Fixes

- **cancelPayment now actually voids the Viva order.** Via the core
  `cancelOrder` fix, cancel routes to `DELETE /api/orders/{orderCode}` on the
  legacy host with Basic auth (the OAuth2 `/checkout/v2/orders/{oc}` route 404s).
  ISV mode builds a Reseller-variant legacy client per call (mirroring the
  Standard refund path) and now **requires reseller credentials** for cancel;
  merchant mode uses the construction-time Merchant Basic client.
- **Shop API resolver no longer short-circuits the metadata fallback.** The
  `cancelPayment` resolver pre-guard rejected a payment when the
  `viva_transaction` row was missing, before the handler ran — making the
  handler's order-code fallback to `payment.metadata` (#33) unreachable. The
  resolver now mirrors the handler: it resolves the order code from the row **or**
  the Payment metadata, so a legitimately-initiated payment stays cancellable
  end-to-end.

### Dependencies

- Bumps `@sakeetech/viva-payments-core` to `0.2.8` (cancelOrder legacy-host fix).

> Note: 0.2.12–0.2.14 were released without CHANGELOG entries; this entry resumes
> the log at the current version.

## 0.2.11

### Bug Fixes

- **`cancelPayment` now frees the local Payment on _any_ non-retryable Viva `cancelOrder` failure, not just `404`** (sakee-tech/vivawallet-npm-public#16).
  The 0.2.10 fix freed the Payment only when Viva returned `404` (order already
  gone). Every **other** non-retryable failure — a `4xx` for an order in a
  non-cancellable state, an already-cancelled order, a transient reject — still
  mapped to `VIVA_API_ERROR` and re-threw, leaving the Vendure `Payment` in
  `Created`. Because `totalCoveredByPayments()` counts `Created`, the stranded
  payment kept "covering" the order: the retry computed `amountToPay = 0` and
  `createPayment` threw `ISV amount (…) must be strictly less than order amount (0)`,
  permanently bricking the order — and the Shop API cannot transition a `Payment`,
  so the storefront had **no recovery path**. The handler now treats every
  non-retryable `cancelOrder` outcome as "the order cannot be voided via the API"
  and still transitions the Payment `Created → Cancelled` + marks the
  `viva_transaction` row `cancelled`, freeing the order for retry. Only genuinely
  retryable errors (5xx / auth / network → `VIVA_AUTH_DOWN`) propagate, so the
  storefront can re-attempt the cancel. This is **race-neutral**: `cancelOrder` on
  an already-captured order returns success (not an error), so the capture/settle
  race already existed on the happy path; a captured order is caught earlier by the
  terminal-status guard, and a late `1796` settle for a force-cancelled Payment
  fails loud in the webhook worker (operator-visible), never a silent double-charge.
  Adds a real-FSM regression guard in `boots-in-vendure.test.ts`.

### Documentation

- **`successUrl` / `failureUrl` documented as bookkeeping-only — they are not sent to Viva** (sakee-tech/vivawallet-npm-public#15).
  These options looked load-bearing (and the JSDoc/README examples implied they
  drove the redirect) but were never transmitted: Viva's Smart Checkout has no
  per-order success-redirect field. The customer's post-payment redirect is
  governed by the payment **source**'s `pathSuccess` / `pathFail` (set via the
  source-onboarding endpoint or the Viva dashboard). The plugin resolves and stores
  the URLs on the `viva_transaction` row metadata for bookkeeping only. JSDoc on the
  options, the README, and the docs site now state this explicitly and point to the
  source as the real redirect lever. Pairs with `@sakeetech/viva-payments-core@0.2.4`,
  which stops emitting the inert fields on the wire. No behavioural change.

## 0.2.10

### Bug Fixes

- **Cancel the local Payment when the Viva void fails because the order is already gone** (sakee-tech/vivawallet-npm-public#14).
  When the storefront recovery path calls `cancelPayment` for a failed/abandoned
  payment, the handler issues `DELETE /checkout/v2/orders/{orderCode}`. If the Viva
  order has expired (or is otherwise non-voidable) Viva returns
  `404 OrdersOrderCodeNotFound`, and the handler used to map that to `VIVA_API_ERROR`
  and re-throw — leaving the Vendure `Payment` in `Created`. Vendure's
  `totalCoveredByPayments()` counts `Created`, so the stranded payment kept
  "covering" the order: the retry computed `amountToPay = 0` (→ `createPayment`
  threw `ISV amount … must be strictly less than order amount (0)`) or a partial
  remainder (→ a second stacked `Created` Viva payment). The order became
  un-payable, accumulating uncancellable payments pointing at dead checkouts.
  A `404` on cancel now means "the order is already gone — nothing left to void",
  so the handler treats it as success-equivalent: it still transitions the Payment
  `Created → Cancelled` and marks the `viva_transaction` row `cancelled`, freeing
  the order so the next `addPaymentToOrder('viva')` computes the **full** amount and
  mints a fresh redirect (pairs with the 0.2.9 expired-redirect fix). The hard-fail
  path is reserved for genuinely retryable (5xx → `VIVA_AUTH_DOWN`) and other
  still-present non-404 errors, which continue to surface unchanged.

## 0.2.9

### Bug Fixes

- **Stop returning a cached redirect URL for an expired Viva order.**
  On a repeat `createPayment` for the same `(channelId, orderId, amount, currency)`,
  the handler returned `viva_transaction.metadata.redirectUrl` from the existing row
  without checking whether the underlying Viva order was still alive. Viva payment
  orders expire (default `paymentTimeout` 1800s); the local row does not. So a
  customer who started a payment, abandoned it, and returned after the Viva order
  expired was redirected to a dead checkout (`OrdersOrderCodeNotFound`) — and
  `createPayment` reported a perfectly valid-looking `Created` payment, so no error
  reached Vendure or the storefront recovery path.
  The row is now treated as a pointer, not the source of truth for the external
  order's liveness. `createPayment` stamps an `expiresAt` on the row at mint time
  (from the Viva `paymentTimeout`) and, on an idempotency hit, reuses the cached
  redirect only while `expiresAt` is still in the future (minus a 60s skew). An
  expired — or pre-fix, `expiresAt`-less — row falls through to mint a fresh Viva
  order and overwrites the row. Double-submit dedup is unchanged: the local row
  stays the dedup authority (Viva does not honour the `Idempotency-Key` header
  server-side, probe F2), so rapid duplicate calls still never create two
  chargeable orders — only the cache's lifetime is now bounded.

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
