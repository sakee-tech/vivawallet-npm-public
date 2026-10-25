# Contributing

Thanks for your interest. Please read this first — the contribution model
here is deliberately narrow.

## This repository is a read-only distribution mirror

The code you see here is **auto-generated from a private monorepo** and
published as the source for the npm packages:

- [`@sakeetech/viva-payments-core`](https://www.npmjs.com/package/@sakeetech/viva-payments-core)
- [`@sakeetech/vendure-payment-viva`](https://www.npmjs.com/package/@sakeetech/vendure-payment-viva)
- [`@sakeetech/medusa-payment-viva`](https://www.npmjs.com/package/@sakeetech/medusa-payment-viva)

Every release **regenerates this repository from scratch** (history is
replaced on each version tag). Because of that:

> **Pull requests are not accepted and will be closed automatically.**
> A PR branch cannot survive the next release — it would be wiped. This is
> not a reflection on the change; it is how the mirror works.

There is no offence intended in closing a PR. The model below exists so
your effort actually lands instead of being lost on the next sync.

## How to contribute: open an issue

All contributions flow through **issues**, which are triaged and
implemented upstream in the private repository, then shipped here on the
next release.

| You want to… | Do this |
|---|---|
| Report a bug | Open a **Bug report** issue |
| Request a feature / change | Open a **Feature request** issue |
| Report a security vulnerability | See [`SECURITY.md`](./SECURITY.md) — **do not** open a public issue |
| Ask a usage question | Open a **Feature request** issue or start a discussion |

Use the issue templates — they capture the details needed to reproduce and
act on a report. Blank issues are disabled to keep reports actionable.

**The more precise the report, the faster the fix.** For bugs, a minimal
reproduction (package version, framework version, config, and the exact
error) is worth more than a paragraph of description.

## Triage & turnaround

This project is maintained by a solo developer with AI-assisted
engineering. Triage flow:

1. Issue is read and labelled (`bug`, `enhancement`, `needs-info`,
   `wontfix`, `duplicate`).
2. Confirmed defects are reproduced against the test suite, fixed
   upstream, covered by a regression test, and released.
3. The issue is closed referencing the published version that contains the
   fix (e.g. "fixed in `vendure-payment-viva@0.2.2`").

`wontfix`/`out-of-scope` decisions are explained, not silent.

## Forking (for local use only)

You are welcome to fork for local experimentation, reading the source, or
building against an unreleased change. Note that forks **cannot be
upstreamed via PR** (see above) — route the change through an issue so it
lands in the next release.

```bash
git clone https://github.com/sakee-tech/vivawallet-npm-public
cd vivawallet-npm-public
pnpm install
pnpm -r build       # build all packages
pnpm -r test        # run the test suites
```

To test a local build inside your own Vendure/Medusa app, point your app's
dependency at the built package (`pnpm add file:../vivawallet-npm-public/packages/<pkg>`)
or use `pnpm link`.

## Scope

These packages are payment infrastructure for Viva Wallet (merchant and
ISV/multi-tenant modes). In scope: the core SDK, the Vendure plugin, the
Medusa provider, their webhooks, refunds, auth, and observability. Out of
scope: app-specific business logic, admin UI/branding, and non-Viva payment
providers — those belong in the consuming application, not the plugin.

## Code of conduct

Participation is governed by [`CODE_OF_CONDUCT.md`](./CODE_OF_CONDUCT.md).
