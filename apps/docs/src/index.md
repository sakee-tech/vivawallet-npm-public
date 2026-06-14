---
layout: home

hero:
  name: VivaWallet Payments
  text: Viva Wallet for Medusa & Vendure
  tagline: By Sakee Technologies AB. Smart Checkout end-to-end — one SDK, two adapters, two modes. Merchant by default, ISV when you opt in.
  actions:
    - theme: brand
      text: Overview
      link: /overview
    - theme: alt
      text: Pick a package
      link: /packages/core
    - theme: alt
      text: View on GitHub
      link: https://github.com/techsakee20/vivawallet

features:
  - icon: 🧩
    title: Framework-agnostic core
    details: viva-payments-core is a zero-dependency SDK — OAuth2, Basic auth, Smart Checkout, refunds, webhooks. No Medusa or Vendure imports.
    link: /packages/core
    linkText: Read the core SDK docs
  - icon: 🛒
    title: Medusa v2 adapter
    details: Ships AbstractPaymentProvider, an idempotent webhook receiver, job worker, internal metrics, and the viva-register-webhooks CLI.
    link: /packages/medusa
    linkText: Install on Medusa
  - icon: 📦
    title: Vendure 3.x adapter
    details: VendurePlugin with payment-method handler, webhook controller, channel custom fields (ISV), and a GraphQL admin extension.
    link: /packages/vendure
    linkText: Install on Vendure
  - icon: 🔀
    title: Two modes, one install
    details: Single-merchant by default. Flip VIVA_MODE=isv (or set reseller env vars) to switch to platform-wide multi-tenant onboarding.
    link: /overview#mode-matrix
    linkText: Compare modes
  - icon: 🔐
    title: Auth & security locked in
    details: OAuth2 client_credentials with single-flight token cache, Basic auth for refunds, HMAC + IP allowlist on webhook ingress.
    link: /reference/auth
    linkText: Read the auth model
  - icon: 🪝
    title: Webhook contract documented
    details: Event types, envelope shape, URL-verify handshake, and a Medusa/Vendure state machine. No guesswork.
    link: /reference/webhooks
    linkText: See webhook spec
---

::: warning Alpha
`v0.2.0` is in active development and gated on the first live-demo
verification. APIs may change before the first stable tag. See the
[migration guide](/guides/migration-0.1-to-0.2) if upgrading from `0.1.x`.
:::
