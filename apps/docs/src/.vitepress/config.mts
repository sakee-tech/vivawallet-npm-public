import { defineConfig } from "vitepress";

// GitHub Pages serves from /<repo>/ unless a custom domain is set.
// Override with DOCS_BASE=/ when deploying to a root domain.
const base = process.env.DOCS_BASE ?? "/vivawallet/";

export default defineConfig({
  base,
  lang: "en-US",
  title: "VivaWallet Payments",
  titleTemplate: ":title · VivaWallet Payments",
  description:
    "VivaWallet Payments by Sakee Technologies AB — Viva Wallet plugins for Medusa v2 and Vendure 3.x. Smart Checkout, refunds, webhooks, multi-mode (merchant + ISV).",
  cleanUrls: true,
  lastUpdated: true,
  ignoreDeadLinks: [
    // Internal-only paths rewritten by sync.mjs to GitHub blob URLs are
    // external from VitePress's perspective, so no special handling needed.
    // This guards against changesets or LICENSE references appearing later.
    /^\/changeset/,
    /^\/license/i,
  ],

  head: [
    ["meta", { name: "theme-color", content: "#0ea5e9" }],
    ["meta", { property: "og:type", content: "website" }],
    ["meta", { property: "og:title", content: "VivaWallet Payments" }],
    ["meta", { property: "og:site_name", content: "VivaWallet Payments" }],
    [
      "meta",
      {
        property: "og:description",
        content:
          "VivaWallet Payments by Sakee Technologies AB — Viva Wallet plugins for Medusa v2 and Vendure 3.x. Smart Checkout, refunds, webhooks, multi-mode (merchant + ISV).",
      },
    ],
  ],

  themeConfig: {
    nav: [
      { text: "Overview", link: "/overview" },
      {
        text: "Packages",
        items: [
          { text: "viva-payments-core (SDK)", link: "/packages/core" },
          { text: "medusa-payment-viva", link: "/packages/medusa" },
          { text: "vendure-payment-viva", link: "/packages/vendure" },
        ],
      },
      {
        text: "Reference",
        items: [
          { text: "Auth", link: "/reference/auth" },
          { text: "Endpoints", link: "/reference/endpoints" },
          { text: "Webhooks", link: "/reference/webhooks" },
          { text: "State machine", link: "/reference/state-machine" },
          { text: "Errors", link: "/reference/errors" },
          { text: "Security", link: "/reference/security" },
          { text: "Glossary", link: "/reference/glossary" },
        ],
      },
      { text: "Migration", link: "/guides/migration-0.1-to-0.2" },
      {
        text: "v0.2.0 (alpha)",
        items: [
          {
            text: "GitHub",
            link: "https://github.com/techsakee20/vivawallet",
          },
          {
            text: "Changesets",
            link: "https://github.com/techsakee20/vivawallet/tree/main/.changeset",
          },
        ],
      },
    ],

    // Sidebar disabled — all navigation lives in the top nav.
    sidebar: false,

    socialLinks: [
      { icon: "github", link: "https://github.com/techsakee20/vivawallet" },
    ],

    search: {
      provider: "local",
    },

    editLink: {
      pattern:
        "https://github.com/techsakee20/vivawallet/edit/main/:path",
      text: "Edit source on GitHub",
    },

    outline: { level: [2, 3] },

    footer: {
      message:
        'Released under the <a href="https://github.com/techsakee20/vivawallet/blob/main/packages/medusa-payment-viva/LICENSE">MIT License</a>. Alpha release.',
      copyright:
        '© 2026 <a href="https://github.com/techsakee20">Sakee Technologies AB</a> · VivaWallet Payments',
    },
  },
});
