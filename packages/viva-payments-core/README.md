# @sakeetech/viva-payments-core

Framework-agnostic Viva Wallet SDK. Used by
[`@sakeetech/medusa-payment-viva`](../medusa-payment-viva) and
[`@sakeetech/vendure-payment-viva`](../vendure-payment-viva). Zero Medusa
or Vendure imports — pure TypeScript on top of `undici`.

Covers the full Smart Checkout surface for both **merchant** and **ISV**
operational modes: OAuth2 client_credentials auth (with token cache +
single-flight refresh), the legacy Basic-auth host (used for refunds),
Fast Refund, webhook verification + state-machine lattice, and structured
error / observability hooks.

---

> **v0.2.0 — alpha. Live demo verification pending.**
>
> Migrating from `0.1.x`? See [`docs/MIGRATION-0.1-to-0.2.md`](https://github.com/sakee-tech/vivawallet-npm-public/blob/main/docs/MIGRATION-0.1-to-0.2.md).
> All locked auth / endpoint / webhook / error / state-machine decisions
> live in [`docs/`](../../docs) — this README links into them rather than
> duplicating.

---

## Install

```bash
pnpm add @sakeetech/viva-payments-core
```

Runtime dep: `undici ^7`. Node.js ≥ 20. ESM-only.

You typically do **not** install this directly — install the Medusa or
Vendure adapter, which depends on this package. Install directly only if
you're building a custom adapter or driving Viva from a non-storefront
context (CLI tool, scheduled job, etc.).

---

## Subpath exports

Every public symbol lives behind a subpath export. Import only what you
need.

| Subpath | Purpose |
|---|---|
| `@sakeetech/viva-payments-core/auth` | OAuth2 client_credentials strategy, Reseller Basic strategy, token cache (in-memory or Redis), single-flight refresh mutex, shared `undici` dispatchers. |
| `@sakeetech/viva-payments-core/payments` | [`Payments`](#payments) — mode-aware Smart Checkout client (`createOrder`, `retrieveTransaction`, `refundPayment`, `cancelOrder`). |
| `@sakeetech/viva-payments-core/isv` | ISV-only API clients: [`IsvAccounts`](#isvaccounts), [`IsvWebhooks`](#isvwebhooks), [`IsvSources`](#isvsources). Also the shared `IsvHttpClient` (OAuth2 HTTP wrapper). |
| `@sakeetech/viva-payments-core/legacy` | [`BasicAuthClient`](#basicauthclient) — wraps Viva's legacy host with Basic auth. Required for refunds; supports `authVariant: 'merchant' \| 'reseller'`. |
| `@sakeetech/viva-payments-core/refunds` | [`FastRefundClient`](#fastrefundclient) (acquiring-scope OAuth2) + [`resolveRefundStrategy`](#resolverefundstrategy) (pure decision function). |
| `@sakeetech/viva-payments-core/webhooks` | URL-verify handshake builder, IP allowlist, HMAC verifier (event 7936), event-type constants, monotonic status lattice, `extractClientIp` source-IP helper with `trustedProxyDepth` X-Forwarded-For walking. |
| `@sakeetech/viva-payments-core/types` | All TypeScript types for the Viva API surface — request / response shapes, card type helpers, status letters, ISV event payloads. |
| `@sakeetech/viva-payments-core/errors` | Error class hierarchy — `VivaError` + specialised subclasses. |
| `@sakeetech/viva-payments-core/observability` | Logger interfaces (`StructuredJsonLogger`, `RedactingLogger`), metrics hooks, tracer hooks, log redactor. |

> The root entry (`@sakeetech/viva-payments-core`) currently only exports
> `VERSION`. Always import from a subpath.

---

## Class reference

Short signatures only — link out for full docs.

### `Payments`

Subpath: `@sakeetech/viva-payments-core/payments`.

```ts
new Payments({
  mode: 'merchant' | 'isv',
  client: IsvHttpClient,           // primary OAuth2 client
  secondaryClient?: IsvHttpClient, // optional 401-fallback (defensive; D15)
  legacyClient?: BasicAuthClient,  // required for refundPayment()
});
```

| Method | Description |
|---|---|
| `createOrder(req, opts?)` | `POST /checkout/v2/orders` (merchant) / `POST /checkout/v2/isv/orders?merchantId={uuid}` (ISV). Returns `{ orderCode, redirectUrl }`. |
| `retrieveTransaction(transactionId, opts?)` | `GET /checkout/v2/[isv/]transactions/{id}`. Idempotent. |
| `refundPayment(transactionId, opts)` | `POST /api/transactions/{id}` on the **legacy host** with Basic auth (probe F1 — v2/OAuth2 path returns 405). Requires `legacyClient`. |
| `cancelOrder(orderCode, opts)` | `DELETE /api/orders/{orderCode}` on the **legacy host** with Basic auth (the v2/OAuth2 `/checkout/v2/orders/{oc}` route returns 404). Requires `legacyClient` — Merchant Basic (M) or a Reseller-variant per call (I). Idempotent. |

Mode behaviour: in merchant mode, `merchantId` (if passed) is silently
ignored; `isvAmount` is stripped from the wire body. In ISV mode,
`merchantId` is required and `VivaValidationError` is thrown if absent.

Deep dives: [`docs/ENDPOINTS.md`](https://github.com/sakee-tech/vivawallet-npm-public/blob/main/docs/ENDPOINTS.md) §2.

### `BasicAuthClient`

Subpath: `@sakeetech/viva-payments-core/legacy`.

```ts
// Merchant variant
new BasicAuthClient({
  authVariant: 'merchant',
  environment: 'demo' | 'production',
  merchantId: string,
  apiKey: string,
});

// Reseller variant — for POST /api/sources in ISV mode
new BasicAuthClient({
  authVariant: 'reseller',
  environment: 'demo' | 'production',
  resellerId: string,
  merchantId: string,
  resellerApiKey: string,
});
```

| Method | Description |
|---|---|
| `request<T>({ method, path, formBody?, jsonBody?, idempotent, ... })` | Generic legacy-API request. Retries on 429/5xx + connection errors per backoff schedule. Returns `LegacyApiResult<T>` with parsed body + Viva tracing headers. |
| `fetchWebhookVerificationKey()` | `GET /api/messages/config/token`. Used by the adapter CLI in merchant mode. |

Auth header format and the merchant/reseller distinction are documented in
[`docs/AUTH.md`](https://github.com/sakee-tech/vivawallet-npm-public/blob/main/docs/AUTH.md) §4.

### `FastRefundClient`

Subpath: `@sakeetech/viva-payments-core/refunds`.

```ts
new FastRefundClient({
  client: IsvHttpClient,    // OAuth2 with `acquiring` scope
  environment: 'demo' | 'production',
});
```

| Method | Description |
|---|---|
| `refund({ transactionId, amount, currencyCode, customerTrns? })` | `POST /acquiring/v1/transactions/{id}:fastrefund`. Returns the refund response or throws `VIVA_FAST_REFUND_INELIGIBLE` on 403. |

Eligibility (Visa / MC / Maestro, card-not-present, merchant approval) is
described in [`docs/ENDPOINTS.md`](https://github.com/sakee-tech/vivawallet-npm-public/blob/main/docs/ENDPOINTS.md) §4.

### `resolveRefundStrategy`

Subpath: `@sakeetech/viva-payments-core/refunds`. Pure function — no I/O.

```ts
function resolveRefundStrategy(
  strategy: 'auto' | 'fast' | 'standard',
  context: { cardType?: string; cardNotPresent: boolean; ... },
): RefundDecision;
```

Returns `{ path: 'fast' | 'standard', reason: string }`. Callers (Medusa
or Vendure adapters) execute the chosen path; on `auto` + 403 Fast Refund
ineligibility, the caller falls back to standard transparently.

Decision table in [`docs/ENDPOINTS.md`](https://github.com/sakee-tech/vivawallet-npm-public/blob/main/docs/ENDPOINTS.md) §4.

### `IsvAccounts`

Subpath: `@sakeetech/viva-payments-core/isv`.

```ts
new IsvAccounts(client: IsvHttpClient);
```

| Method | Description |
|---|---|
| `createConnectedAccount({ email, returnUrl, branding? })` | `POST /isv/v1/accounts`. Returns `{ accountId, onboardingUrl }`. |
| `retrieveConnectedAccount(accountId)` | `GET /isv/v1/accounts/{id}`. Returns current verification + payouts state. |

Onboarding flow + 8194 verification webhook: [`docs/WEBHOOKS.md`](https://github.com/sakee-tech/vivawallet-npm-public/blob/main/docs/WEBHOOKS.md) §4.

### `IsvWebhooks`

Subpath: `@sakeetech/viva-payments-core/isv`.

```ts
new IsvWebhooks(client: IsvHttpClient);
```

| Method | Description |
|---|---|
| `registerWebhook({ eventTypeId, webhookUrl })` | `POST /isv/v1/webhooks`. Idempotent — Viva returns the existing registration on duplicate. |
| `getVerificationKey()` | `GET /isv/v1/webhooks/token`. The CLI uses this to populate `VIVA_WEBHOOK_VERIFICATION_KEY` in ISV mode. |

### `IsvSources`

Subpath: `@sakeetech/viva-payments-core/isv`.

```ts
new IsvSources(basic: BasicAuthClient);  // MUST be authVariant: 'reseller'
```

| Method | Description |
|---|---|
| `createEcommerceSource(input)` | `POST /api/sources` (legacy host, Reseller Basic auth). Creates a Smart Checkout source for a connected merchant. |
| `createPhysicalSource(input)` | Same endpoint, for in-store / physical sources. |

ISV-only. The Medusa / Vendure admin route surfaces this as
`POST /viva/admin/connected-accounts/:id/sources`.

### `validateStatusTransition` + `mapStatusLetter`

Subpath: `@sakeetech/viva-payments-core/webhooks`. Pure functions —
no I/O.

```ts
mapStatusLetter(letter: 'F' | 'C' | 'A' | 'R' | 'E' | 'X' | 'M' | ...): {
  plugin: 'pending' | 'authorized' | 'captured' | 'refunded' | 'failed' | 'cancelled' | 'disputed';
  framework: 'authorized' | 'captured' | 'refunded' | 'error' | 'canceled' | 'requires_more';
};

validateStatusTransition(current, next): StatusTransitionResult;
```

The lattice is monotonic forward — redelivered events on terminal states
are no-ops; backward transitions log WARN; illegal transitions log ERROR
and leave `processed_at NULL`. Full table:
[`docs/STATE-MACHINE.md`](https://github.com/sakee-tech/vivawallet-npm-public/blob/main/docs/STATE-MACHINE.md).

---

## Error classes

Subpath: `@sakeetech/viva-payments-core/errors`. Every public method
throws one of these.

| Class | Thrown when |
|---|---|
| `VivaError` | Abstract base. All others extend this. Carries `code: VivaErrorCode`, `message`, `retryable: boolean`, optional `vivaErrorCode` / `vivaErrorMessage` / `cause`. |
| `VivaAuthError` | OAuth2 token endpoint unavailable, 401 after force-refresh, or auth-layer misconfig. `retryable: true` for transient. |
| `VivaApiError` | Viva returned a 4xx/5xx that doesn't map to a more specific code. Carries the original HTTP status + Viva error code. |
| `VivaValidationError` | Local input validation failed (missing `merchantId` in ISV mode, invalid currency code, etc.). Never retryable. |
| `VivaWebhookError` | URL-verify mismatch, IP not allowlisted, HMAC verification failed. Never retryable. |
| `VivaRateLimitError` | Viva returned 429. Carries `retryAfterSeconds`. Retryable per backoff schedule. |
| `VivaModeMismatchError` | ISV-only API called when client was constructed with `mode: 'merchant'` (or vice versa). |

Full envelope shape, Viva→plugin code mapping, and per-code retryable
flag in [`docs/ERRORS.md`](https://github.com/sakee-tech/vivawallet-npm-public/blob/main/docs/ERRORS.md).

---

## Mode-aware behaviour

Two surfaces in this SDK switch behaviour by mode.

**`Payments`** is constructed with `mode: 'merchant' | 'isv'`. The URL
builder for `createOrder`, `retrieveTransaction`, and `cancelOrder`
toggles the `/isv` segment and the `?merchantId={uuid}` query param.
`refundPayment` is mode-agnostic — it always uses `legacyClient` against
the legacy host (probe F1 verified). In merchant mode, `merchantId` and
`isvAmount` are silently ignored; in ISV mode, `merchantId` is required.

**`BasicAuthClient`** takes `authVariant: 'merchant' | 'reseller'`. The
merchant variant authenticates with `merchantId + apiKey` (the standard
legacy Basic pair, used for refunds in both modes). The reseller variant
authenticates with `resellerId + merchantId + resellerApiKey` and is only
used for `POST /api/sources` in ISV mode. The two variants share the
same HTTP client; only the `Authorization` header differs.

Auth flow detail in [`docs/AUTH.md`](https://github.com/sakee-tech/vivawallet-npm-public/blob/main/docs/AUTH.md). Endpoint
matrices per mode in [`docs/ENDPOINTS.md`](https://github.com/sakee-tech/vivawallet-npm-public/blob/main/docs/ENDPOINTS.md) §2.

---

## Deprecated aliases (`0.2.x` only — removed in `0.3.0`)

The pre-multi-mode classes still ship as wrappers for one-minor
back-compat.

| Deprecated | Use instead |
|---|---|
| `IsvPayments` (from `/isv`) | `Payments` from `/payments` with `mode: 'isv'` explicitly set. |
| `LegacyBasicClient` (from `/isv`) | `BasicAuthClient` from `/legacy` with `authVariant: 'merchant'`. |
| `LegacyBasicClientConfig` | `BasicAuthClientConfig`. |

Both aliases preserve the pre-slice constructor signatures and pin the
correct mode / variant internally. They emit no warnings at runtime — the
deprecation marker is the JSDoc tag — but they will be **deleted** in
`0.3.0`. Migration steps:
[`docs/MIGRATION-0.1-to-0.2.md`](https://github.com/sakee-tech/vivawallet-npm-public/blob/main/docs/MIGRATION-0.1-to-0.2.md).

---

## Example — construct everything for ISV mode

The Medusa and Vendure adapters do this internally; you generally won't
call the SDK directly. Shown here as a reference for custom integrations.

```ts
import {
  OAuth2ClientCredentialsStrategy,
  InMemoryTokenCache,
  AsyncMutex,
  getAuthDispatcher,
  getApiDispatcher,
} from '@sakeetech/viva-payments-core/auth';
import { IsvHttpClient } from '@sakeetech/viva-payments-core/isv';
import { BasicAuthClient } from '@sakeetech/viva-payments-core/legacy';
import { Payments } from '@sakeetech/viva-payments-core/payments';
import { FastRefundClient } from '@sakeetech/viva-payments-core/refunds';
import { IsvAccounts, IsvWebhooks, IsvSources } from '@sakeetech/viva-payments-core/isv';
import { StructuredJsonLogger } from '@sakeetech/viva-payments-core/observability';

const env = 'demo' as const;
const logger = new StructuredJsonLogger();

// 1. OAuth2 strategy — token cache + single-flight refresh.
const oauth2 = new OAuth2ClientCredentialsStrategy({
  environment: env,
  clientId: process.env.VIVA_CLIENT_ID!,
  clientSecret: process.env.VIVA_CLIENT_SECRET!,
  scope: 'urn:viva:payments:core:api:isv urn:viva:payments:core:api:acquiring',
  tokenCache: new InMemoryTokenCache(),
  refreshMutex: new AsyncMutex(),
  dispatcher: getAuthDispatcher(),
});

// 2. OAuth2 HTTP client — wraps undici fetch with the strategy.
const isvClient = new IsvHttpClient({
  environment: env,
  authStrategy: oauth2,
  dispatcher: getApiDispatcher(),
  logger,
});

// 3. Legacy Basic client — required for refundPayment().
const legacy = new BasicAuthClient({
  authVariant: 'merchant',
  environment: env,
  merchantId: process.env.VIVA_MERCHANT_ID!,
  apiKey: process.env.VIVA_API_KEY!,
});

// 4. Mode-aware Smart Checkout client.
const payments = new Payments({
  mode: 'isv',
  client: isvClient,
  legacyClient: legacy,
});

// 5. Fast Refund (optional — `resolveRefundStrategy` decides whether to use it).
const fastRefund = new FastRefundClient({
  client: isvClient,
  environment: env,
});

// 6. ISV-only surfaces.
const accounts = new IsvAccounts(isvClient);
const webhooks = new IsvWebhooks(isvClient);

// Reseller Basic client + sources — only if VIVA_RESELLER_* are set.
const resellerBasic = new BasicAuthClient({
  authVariant: 'reseller',
  environment: env,
  resellerId: process.env.VIVA_RESELLER_ID!,
  merchantId: process.env.VIVA_RESELLER_MERCHANT_ID!,
  resellerApiKey: process.env.VIVA_RESELLER_API_KEY!,
});
const sources = new IsvSources(resellerBasic);

// Now use:
const order = await payments.createOrder(
  { amount: 9999n, currencyCode: '978', merchantId: 'uuid-of-connected-merchant', ... },
);
```

For merchant mode, swap `mode: 'isv'` → `mode: 'merchant'`, change the
OAuth2 scope to `urn:viva:payments:core:api:redirectcheckout
urn:viva:payments:core:api:acquiring`, drop `IsvAccounts` / `IsvWebhooks`
/ `IsvSources`, and stop passing `merchantId` to `createOrder`.

---

## Versioning

Semver. Breaking changes only on major bumps. `0.x` minors may introduce
new subpath exports and new method overloads, but won't break existing
public signatures. Deprecated aliases get **one** minor of back-compat
before deletion.

See [`CHANGELOG.md`](./CHANGELOG.md). The monorepo uses
[changesets](https://github.com/changesets/changesets) — all three
packages bump together.

---

## Tests + development

```bash
pnpm test         # vitest — 242 tests at the time of writing
pnpm typecheck    # tsc --noEmit
pnpm build        # tsc emit → dist/
```

The test suite covers unit tests per module plus sandbox-shaped scenario
tests (duplicate webhook delivery, status lattice transitions, token
single-flight contention, etc.). All tests run hermetically — no network
calls. The live-sandbox probes live in `scripts/` at the repo root and are
run manually.

---

## License

MIT. See [`LICENSE`](./LICENSE).

## Contributing

Internal SaaS use for now. Contributions welcome once `0.2.0` stabilises
after the first live demo. Any behaviour change should reference the
locked decision it touches (auth, endpoints, webhooks, errors, state
machine) in [`docs/`](../../docs).
