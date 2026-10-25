# viva-payments

Viva Wallet plugins for **Medusa v2** and **Vendure 3.x**. Smart Checkout
end-to-end. Three operational modes — **merchant** (default), **ISV**
(opt-in), **marketplace** (reserved, not shipped).

---

> **Status — alpha.** `v0.2.0` is in active development; first live demo
> verification is pending. All locked decisions (auth, endpoints, webhook
> contract, error envelope, state machine) live in [`docs/`](./docs) —
> adapter and core READMEs link into them rather than duplicating.

---

## Packages

This is a pnpm + changesets monorepo. Three published packages plus reference
docs.

| Package | Install | Description | Docs |
|---|---|---|---|
| [`@sakeetech/viva-payments-core`](./packages/viva-payments-core) | [public mirror](#install) | Framework-agnostic Viva Wallet SDK. OAuth2, Basic auth, Smart Checkout, refunds, webhooks, observability hooks. Zero Medusa or Vendure imports. | [`packages/viva-payments-core/README.md`](./packages/viva-payments-core/README.md) |
| [`@sakeetech/medusa-payment-viva`](./packages/medusa-payment-viva) | [public mirror](#install) | Medusa v2 payment provider. Wraps the core SDK and adapts it to Medusa's `AbstractPaymentProvider` interface. Ships a webhook receiver, idempotent job worker, internal metrics, and the `viva-register-webhooks` CLI. | [`packages/medusa-payment-viva/README.md`](./packages/medusa-payment-viva/README.md) |
| [`@sakeetech/vendure-payment-viva`](./packages/vendure-payment-viva) | [public mirror](#install) | Vendure 3.x plugin. Wraps the core SDK as a `VendurePlugin` with payment-method handler, webhook controller, channel custom fields (ISV), GraphQL admin extension, and the matching CLI. | [`packages/vendure-payment-viva/README.md`](./packages/vendure-payment-viva/README.md) |

All three packages target Node.js ≥ 20 and ship ESM-only.

<a id="install"></a>

### Install

Packages ship through the public mirror at
[`github.com/sakee-tech/vivawallet-npm-public`](https://github.com/sakee-tech/vivawallet-npm-public).
The mirror carries pre-built `dist/` for every package and is tagged
`vX.Y.Z` in lockstep with this repo. Consumers install pinned to a tag:

```bash
# pnpm (recommended — supports workspace subpath addressing)
pnpm add "github:sakee-tech/vivawallet-npm-public#v0.2.1&path:/packages/viva-payments-core"
pnpm add "github:sakee-tech/vivawallet-npm-public#v0.2.1&path:/packages/medusa-payment-viva"
pnpm add "github:sakee-tech/vivawallet-npm-public#v0.2.1&path:/packages/vendure-payment-viva"
```

For npm/yarn use the equivalent `git+https://…#v0.2.1` URL with a
`gitpkg.now.sh`-style subpath bridge. The mirror is distribution-only:
no workflows, no `prepare` scripts, no internal docs.

---

## Mode matrix

The plugins run in one of two operational modes today. **Marketplace is a
reserved seam — no public API in `0.2.x`.**

| Capability | `merchant` *(default)* | `isv` *(opt-in)* | `marketplace` |
|---|---|---|---|
| **Who it's for** | Single direct Viva merchant — your store, your account | SaaS / platform onboarding many merchants under one ISV partner agreement | Reserved — not shipped |
| **Required credentials** | One OAuth2 pair + one legacy Basic pair (for refunds) | Platform-wide OAuth2 + legacy Basic + optional Reseller Basic | — |
| **OAuth2 scope** | `urn:viva:payments:core:api:redirectcheckout` (+ `acquiring` for Fast Refund) | `urn:viva:payments:core:api:isv` (+ `acquiring`) | — |
| **Per-call merchant scoping** | None — token IS the merchant | `?merchantId={uuid}` query on every Smart Checkout / transaction call | — |
| **Smart Checkout path** | `POST /checkout/v2/orders` | `POST /checkout/v2/isv/orders?merchantId={uuid}` | — |
| **Channel / store custom fields** | None | `vivaMerchantId`, `vivaPayoutsEnabled` (Vendure: per-channel) | — |
| **Admin REST surface** | `GET /viva/internal/*`, `GET /viva/webhook/health` | …plus `POST/GET /viva/admin/connected-accounts/*`, `POST .../sources` | — |
| **CLI behaviour** (`viva-register-webhooks`) | Manual setup — prints URLs + verification key to paste into Viva Self Care | Automated — `POST /isv/v1/webhooks` per V1 event type | — |
| **Webhook events handled** | 1796, 1797, 1798, 4865 | …plus 8193 (Account Connected), 8194 (Account Verification) | — |
| **Onboarding flow** | None — merchant signs up with Viva directly | `POST /isv/v1/accounts` → hosted KYC → 8194 verification webhook | — |

Full auth and endpoint detail in [`docs/AUTH.md`](./docs/AUTH.md) and
[`docs/ENDPOINTS.md`](./docs/ENDPOINTS.md). Marketplace scoping is reserved
as a config-union seam only — no public API ships in `0.2.x`.

---

## Choose your install

**Single merchant?** (the 90% case)
- Install [`@sakeetech/medusa-payment-viva`](./packages/medusa-payment-viva) **or** [`@sakeetech/vendure-payment-viva`](./packages/vendure-payment-viva) — both default to `mode: 'merchant'`.
- Set `VIVA_CLIENT_ID` / `VIVA_CLIENT_SECRET` (Smart Checkout OAuth2) and `VIVA_MERCHANT_ID` / `VIVA_API_KEY` (legacy Basic, used for refunds).
- Run the CLI once to print webhook URLs; paste them into Viva Self Care.
- See the adapter README for the full quick start.

**ISV partner?** (multi-tenant SaaS)
- Same install. Set `VIVA_MODE=isv` (or set any `VIVA_RESELLER_*` to auto-detect).
- Use platform-wide OAuth2 credentials issued under your ISV partner contract.
- The CLI calls `POST /isv/v1/webhooks` directly — no Self Care UI step.
- See the adapter README **and** [`docs/MIGRATION-0.1-to-0.2.md`](./docs/MIGRATION-0.1-to-0.2.md).

**Marketplace?** Not shipped in `0.2.x` — reserved as a config-union seam
only. No public API.

---

## Repo layout

```
vivawallet/
├── packages/
│   ├── viva-payments-core/        # framework-agnostic SDK
│   ├── medusa-payment-viva/       # Medusa v2 payment provider
│   └── vendure-payment-viva/      # Vendure 3.x plugin
├── docs/                          # canonical specifications (mirrored to public repo)
│   ├── AUTH.md
│   ├── ENDPOINTS.md
│   ├── WEBHOOKS.md
│   ├── STATE-MACHINE.md
│   ├── ERRORS.md
│   ├── GLOSSARY.md
│   ├── SECURITY.md
│   ├── VENDURE-CONTRACT.MD
│   ├── MIGRATION-0.1-to-0.2.md
│   └── internal/                  # planning / TODOs / resume — private only, never mirrored
├── pnpm-workspace.yaml
└── package.json
```

---

## Documentation map

The `docs/` directory is the canonical reference. READMEs deliberately do
**not** duplicate it — they link in.

| Document | Covers |
|---|---|
| [`docs/AUTH.md`](./docs/AUTH.md) | OAuth2 scopes, client_credentials flow, Basic-auth variants (merchant vs reseller), token cache + single-flight design. |
| [`docs/ENDPOINTS.md`](./docs/ENDPOINTS.md) | Every Viva endpoint the plugins call, per mode, with method + path + auth + retry policy. Adapter REST surface in §3. |
| [`docs/WEBHOOKS.md`](./docs/WEBHOOKS.md) | Event types, envelope shape, registration flows (merchant vs ISV), URL-verify handshake, IP allowlist, HMAC scope. |
| [`docs/STATE-MACHINE.md`](./docs/STATE-MACHINE.md) | Viva `StatusId` → plugin status → Medusa / Vendure payment state. Monotonic lattice + stale-order re-walk. |
| [`docs/ERRORS.md`](./docs/ERRORS.md) | `VivaPluginError` envelope, error code catalogue, Viva→plugin mapping, retryable flags. |
| [`docs/GLOSSARY.md`](./docs/GLOSSARY.md) | Vocabulary — merchant / ISV / reseller / source / order code / etc. |
| [`docs/SECURITY.md`](./docs/SECURITY.md) | Secret hygiene, log redaction, webhook auth model, admin token gating. |
| [`docs/MIGRATION-0.1-to-0.2.md`](./docs/MIGRATION-0.1-to-0.2.md) | Upgrade path from `0.1.x` (ISV-only) to `0.2.x` (multi-mode). Deprecated env aliases + deprecated class aliases. |

---

## Development

```bash
# Clone and install
git clone <repo-url> vivawallet
cd vivawallet
pnpm install

# Build the core SDK first (adapters depend on its subpath exports)
pnpm -F @sakeetech/viva-payments-core build

# Run the full check across all packages
pnpm precheck     # build core + typecheck all + test all

# Or run individually
pnpm typecheck
pnpm test
pnpm build
```

The `precheck` script matches the local pre-push hook — if it passes
locally, the hook passes. There is no remote CI gate; the hook is the gate.

### Working on a single package

```bash
pnpm -F @sakeetech/viva-payments-core   test
pnpm -F @sakeetech/medusa-payment-viva  test
pnpm -F @sakeetech/vendure-payment-viva test
```

### Releases

Versioning via [changesets](https://github.com/changesets/changesets):

```bash
pnpm changeset             # describe the change
pnpm version-packages      # bump versions + write CHANGELOGs
pnpm release               # build + publish
```

`0.2.0` is gated on first live demo verification and has not yet shipped.

---

## License

MIT. See [`LICENSE`](./LICENSE) (per-package).

## Contributing

Internal SaaS use for now. Contributions welcome once `0.2.0` stabilises
after the first live demo. Open issues or discussions in the project
repository.
