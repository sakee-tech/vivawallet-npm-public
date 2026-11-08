# Security Policy

These packages handle payment flows, OAuth2 credentials, and webhook
verification. Security reports are taken seriously and prioritised above
all other work.

## Reporting a vulnerability

**Do not open a public issue, discussion, or pull request for a security
vulnerability.** Public disclosure before a fix is available puts every
consumer at risk.

Instead, use GitHub's private vulnerability reporting:

1. Go to the **Security** tab of this repository.
2. Click **Report a vulnerability**.
3. Provide a description, affected package + version, reproduction steps,
   and impact.

This opens a private advisory visible only to the maintainer and you.

## What to expect

- **Acknowledgement** within a few days.
- **Assessment**: severity is triaged; if confirmed, a fix is developed
  privately in the upstream repository.
- **Fix & release**: a patched version is published to npm, and a GitHub
  Security Advisory (with CVE where applicable) is published.
- **Credit**: reporters are credited in the advisory unless they prefer to
  remain anonymous.

## Supported versions

Only the **latest published minor** of each package receives security
fixes. Upgrade to the current release before reporting — the issue may
already be resolved.

| Package | Supported |
|---|---|
| `@sakeetech/viva-payments-core` | latest minor |
| `@sakeetech/vendure-payment-viva` | latest minor |
| `@sakeetech/medusa-payment-viva` | latest minor |

## Scope

In scope: authentication/token handling, webhook signature & source-IP
verification, refund/capture authorization, data exposure in logs, and
injection via webhook payloads.

Out of scope: vulnerabilities in your own application code, in the Viva
Wallet platform itself, or in transitive dependencies (report those
upstream).
