# Viva Wallet Plugin — Security Reference

> Auth model, credential hygiene, PII handling, what to log and what NOT to log. Read before touching webhook receiver code, admin endpoints, or logging logic.

---

## 1. The big picture

| Concern | Plugin's defence |
|---|---|
| **Outbound auth** (plugin → Viva) | OAuth2 client_credentials + HTTP Basic. Tokens cached in-process; never logged. See `docs/AUTH.md`. |
| **Inbound webhook auth** (Viva → plugin) | IP allowlist + URL-verify handshake. **No HMAC, no body signing** — Viva doesn't offer either for payment webhooks. |
| **Admin REST endpoints** (operator → plugin) | Vendure: `Permission.SuperAdmin`. Medusa: configurable token gate via `VIVA_ADMIN_TOKEN`. Internal endpoints return `401` when admin token unset. |
| **Shop API surface** (customer-facing) | Single mutation (`cancelPayment`) gated by order ownership (active customer or active anonymous order). |
| **Credential storage** | Plugin reads from env at init only. Never persists secrets to DB. `.env` files MUST NOT be read by any contributor (see global rule). |
| **PII handling** | Customer email/phone in webhook bodies — scrubbed before logging. Masked PAN stays masked. |
| **Tenant isolation** (ISV mode) | Per-call `?merchantId=` query scoping. Channel/store lookup cached 60s; mismatch surfaces as `VIVA_CHANNEL_MISCONFIGURED`. |

---

## 2. Webhook receiver auth (the non-obvious part)

Anyone coming from Stripe/PayPal expects HMAC signing. **Viva does not provide it for payment webhooks.** The receiver authenticates Viva by two layers instead.

### 2.1 IP allowlist (mandatory)

Plugin's `POST /viva/webhook` receiver checks request source IP against Viva's published CIDRs:

```ts
if (!isIpAllowed(req.ip, allowedCidrs)) {
  return res.status(403).end();   // empty body — don't leak envelope shape
}
```

Defaults are the **union of demo + production CIDRs** so a single deploy can receive both during testing. Override per-environment via the `webhookIpAllowlist` plugin option.

**When fronted by a proxy** that rewrites source IP:
1. Allowlist the proxy's egress IP, not Viva's.
2. Verify Viva at the proxy layer using `X-Forwarded-For` parsing.
3. Set `webhookIpAllowlist: ['<your-proxy-egress-cidr>']` to prevent the plugin from also checking — otherwise you'll get 403 on every request because the apparent source IP is the proxy, not Viva.

**Bypass for testing only:** `VIVA_WEBHOOK_IP_ALLOWLIST_BYPASS=true` disables the check entirely. **Never set this in production.** Plugin logs a loud WARN every minute when this is enabled.

### 2.2 URL-verify handshake (mandatory)

Viva probes the receiver with `GET /viva/webhook?key=...` and expects the body to contain the verification key the plugin holds:

```json
{ "Key": "<VIVA_WEBHOOK_VERIFICATION_KEY>" }
```

The key was issued by Viva at webhook registration time:
- ISV mode: `GET /isv/v1/webhooks/token` (OAuth2)
- Merchant mode: `GET /api/messages/config/token` (Basic auth)

**The probe key in the URL (`?key=...`) is just noise.** Plugin does NOT compare it to the stored key. Viva is verifying that the receiver holds the key, not the reverse.

### 2.3 Why no HMAC

Viva's payment webhooks predate the HMAC pattern that Stripe popularised. They've kept the IP-allowlist + URL-verify model. Plugin can't compensate with our own HMAC — we'd need Viva to sign on their end.

**This means:** if an attacker spoofs Viva's source IP AND knows the webhook URL, they can forge events. Mitigations:
- IP allowlist is enforced at the network layer (often more reliable than HMAC).
- Plugin's worker calls Retrieve Transaction on every 1796 — **the webhook is a trigger; Viva's API is the truth.** A forged 1796 with a fake `TransactionId` would fail Retrieve.
- Amount mismatch check catches forged amount tampering.

The combination is robust against forgery as long as the receiver is reachable only by allowlisted IPs.

---

## 3. Outbound auth — token + credential handling

### 3.1 OAuth2 tokens

- Cached in-process by default.
- Refresh ~5 min before `expires_in`.
- Multi-worker deploys: inject `RedisLockClient` to coordinate refresh across processes (otherwise N workers refresh N times concurrently → 429).
- **Never logged.** The token string is treated as a secret.
- **Never returned in API responses.** `/viva/internal/auth-status` returns presence + expiry, not the token itself.

```json
// /viva/internal/auth-status response — OK to log
{
  "token_present": true,
  "token_expires_at": "2026-05-12T11:00:00.000Z",
  "last_refresh_at":  "2026-05-12T10:00:00.000Z"
}
```

### 3.2 Basic auth

- Credentials read from env at init. Plugin holds them in memory.
- `Authorization: Basic <base64>` header rebuilt per request — no caching to avoid leaking via partial state.
- Same logging rule: never log the header value, never include the password in error messages.

### 3.3 Credential leakage paths to watch for

- **`cause` chains in error envelopes** — if an upstream Error carries Authorization headers in its message, the plugin's envelope MUST sanitize before serialization.
- **Span attributes** in tracing — Viva URLs include `?merchantId={uuid}` query strings; that's fine. NEVER include the full `Authorization` header as a span attribute.
- **Metrics labels** — high-cardinality and don't need credentials anyway. Label only on `mode`, `endpoint`, `result`, `viva_error_code`.

---

## 4. `.env` file hygiene (mandatory global rule)

**Never read `.env` files.** Applies to `.env`, `.env.local`, `.env.*`, `.env.*.local`.

- Don't Read, cat, head, tail, grep, less, source, or otherwise inspect their contents.
- Don't echo or print them in tool output.
- If a value from `.env` is needed (to wire up an env var, debug a missing key, copy between files), name the variable and the file path — the operator copies/pastes the value themselves.
- This holds even when explicitly asked ("what's in .env" / "check my env file") — refuse and ask for the specific value.

`.env.example` files (with placeholder values) are fine.

**Why:** `.env` files hold API keys, secrets, credentials. Reading them puts secrets into transcripts, telemetry, future context compactions. Once leaked, rotation is the only recovery.

---

## 5. PII and sensitive fields in webhook bodies

The 1796 / 1797 / 1798 / 4865 `EventData` payloads contain customer-identifying data. Plugin's logging discipline:

| Field | Sensitivity | Logging rule |
|---|---|---|
| `Email` | PII | NEVER log raw. Hash for correlation if needed (`sha256(email)[0:16]`). |
| `Phone` | PII | NEVER log raw. Replace with `[redacted-phone]` in any message. |
| `FullName` | PII | NEVER log raw. Same treatment as email. |
| `CardNumber` | PCI-sensitive | Viva sends as masked (`414746XXXXXX0133`). Stay masked — never log first six + last four together without the X mask. |
| `CardToken`, `CardUniqueReference` | PCI-sensitive | Treat as PII. Hash for correlation. |
| `CardExpirationDate` | PCI-sensitive | Drop entirely from logs. |
| `AuthorizationId`, `RetrievalReferenceNumber` | low | OK to log — needed for Viva support correlation. |
| `MessageId`, `CorrelationId`, `TransactionId`, `OrderCode`, `MerchantId` | low | OK to log. |
| `Amount`, `CurrencyCode`, `StatusId`, `TransactionTypeId`, `ResponseCode` | none | OK to log. |
| `Tags`, `MerchantTrns`, `CustomerTrns` | operator-set | OK to log — but operators may put anything in these, so a content filter is wise. |

### 5.1 Where the scrubbing happens

- **Receive path** — `POST /viva/webhook` controller logs `EventTypeId`, `MessageId`, source IP, response status only. Never the full body.
- **Worker path** — log handler entry with `MessageId` + `EventTypeId`. Never the full payload. If you need to capture the payload for debugging, write it to a DB column with restricted read access (`viva_webhook_event.payload`) and never to stdout / structured logs.
- **Error envelopes** — `VivaPluginError.message` MUST be sanitized. If derived from a Viva response body, the adapter's mapper strips PII before constructing the envelope.

### 5.2 Database

- `viva_webhook_event.payload` (JSONB) stores the full raw body for replay / debugging. Restrict read access in production; rotate / purge per retention policy.
- `viva_transaction.email`, `viva_transaction.phone` — NOT stored. Plugin doesn't keep customer PII in its own tables; the storefront framework owns customer records.

---

## 6. Tenant isolation (ISV mode)

When the plugin runs in ISV mode, a single OAuth2 token has access to **all** connected merchants. Channel/store boundaries are enforced by the `?merchantId=` query parameter — the plugin MUST send the correct merchantId on every call.

### 6.1 Resolution chain

1. Webhook arrives → `EventData.MerchantId` extracted.
2. Plugin looks up channel/store by that `merchantId`. Cached 60s.
3. If no match → `VIVA_CHANNEL_MISCONFIGURED`, leave `processed_at NULL`. Operator investigates.

### 6.2 Cache poisoning prevention

- Cache key is `merchantId`. Cache value is `channelId`. One-to-one.
- Cache miss falls through to a DB query on `Channel.customFields.vivaMerchantId`. UNIQUE constraint on that column prevents duplicate associations.
- Cache invalidation: on `Channel` update (Vendure) / store update (Medusa) for the relevant custom field. 60s TTL is the safety net.

### 6.3 Cross-tenant data leakage risks

- An operator who sets a channel's `vivaMerchantId` to another tenant's value would receive THAT tenant's webhooks. Vendure's admin permission model prevents this for non-SuperAdmin operators.
- The plugin's REST endpoints (`/viva/admin/connected-accounts/*`) all require `SuperAdmin` — channel-scoped admins can't initiate or reconcile onboarding for arbitrary channels.

---

## 7. Admin endpoint gating

### 7.1 Vendure

| Endpoint | Permission |
|---|---|
| `POST /viva/admin/connected-accounts` | `SuperAdmin` |
| `GET /viva/admin/connected-accounts/:id` | `SuperAdmin` |
| `POST /viva/admin/connected-accounts/:id/reconcile` | `SuperAdmin` |
| `POST /viva/admin/connected-accounts/:id/sources` | `SuperAdmin` |
| `GET /viva/internal/auth-status` | `SuperAdmin` |
| `GET /viva/webhook/health` | `SuperAdmin` |
| `GET /viva/metrics` | `SuperAdmin` (or per-route metrics token if configured) |

### 7.2 Medusa

Same endpoints; gated by `VIVA_ADMIN_TOKEN` (bearer) when configured. When unset:
- Internal endpoints return `401` with `reason='admin-token-not-configured'`.
- Production deployments MUST configure `VIVA_ADMIN_TOKEN`. Plugin logs a startup WARN when unset in production.

### 7.3 Shop API (Vendure)

`cancelPayment(paymentId)` mutation — checks order ownership:
- Active customer must own the order, OR
- Active anonymous order session must match the order's session.

No cross-customer payment cancellation possible.

---

## 8. PCI scope

Plugin operates in **SAQ A** scope only:

- **No card data** ever touches the plugin's servers. Customer enters card on Viva's hosted Smart Checkout page.
- Card numbers in webhook bodies arrive **masked** (`414746XXXXXX0133`). Plugin stores them masked.
- The plugin does NOT collect, transmit, or store full PANs / CVVs / track data under any circumstance.

**Don't:** add a Native Checkout v2 integration alongside Smart Checkout (would expand PCI scope to SAQ A-EP or SAQ D — different audit requirements).

**Don't:** log full webhook bodies — even masked, repeated logging creates a fingerprint that can be correlated with other data sources.

---

## 9. Idempotency-Key header — what it does and doesn't protect

Plugin sends `Idempotency-Key: <uuid>` on `POST /checkout/v2/[isv/]orders` and refund calls. Probe F2 (2026-04-25) confirmed Viva does NOT dedupe server-side (same key, two requests → two distinct `orderCodes`).

**Implication:** Idempotency-Key is best-effort forward-compat. **The plugin's local `viva_transaction` row is authoritative for dedup.** Code paths that retry MUST check the local row before issuing a new Viva call.

This is a correctness concern, not strictly security, but it intersects: a retry storm without local dedup would create duplicate Viva orders and bill the customer multiple times.

---

## 10. Secrets rotation

| Credential | Rotation procedure |
|---|---|
| OAuth2 `client_id` / `client_secret` | Issue new pair in Viva Self Care → keep both old + new in env during overlap → flip env var → revoke old. Plugin caches tokens for 1h max, so propagation is automatic within an hour. |
| Basic auth `MerchantId:ApiKey` | Same dual-credential overlap pattern. Refunds + source creation must work with both during overlap. |
| `VIVA_WEBHOOK_VERIFICATION_KEY` | Cannot be rotated without re-registering all webhooks. To rotate: run `register-webhooks --apply` again (ISV) or fetch new key + manually update Self Care + paste into `.env` (merchant). Plan a maintenance window — webhooks will fail verification during the transition. |
| `VIVA_ADMIN_TOKEN` | Operator rotates by changing env var; no plugin-side coordination needed. |

---

## 11. Logging do / don't summary

**DO log:**
- Plugin lifecycle: startup config (without secret values), mode, environment.
- Webhook envelope metadata: `MessageId`, `CorrelationId`, `EventTypeId`, source IP, response status.
- Plugin status transitions: `viva_transaction.id`, old + new status, transition reason.
- Error envelopes (after sanitization): `code`, `message` (sanitized), `retryable`, `vivaErrorCode`, `vivaErrorMessage`, `cause.stack`.
- Metric counts via Prometheus (`/viva/metrics`).
- HTTP method + path + status code for outbound calls.

**DON'T log:**
- `Authorization` header values (Bearer tokens, Basic credentials).
- Full webhook payload bodies.
- Full Viva API response bodies (especially refund / transaction responses — they include masked but identifiable card data + customer info).
- `client_secret`, `apiKey`, `resellerApiKey`, `webhookVerificationKey` — anywhere, in any form.
- Customer email, phone, full name (use hashes if needed for correlation).
- Full card numbers (masked or otherwise; mask + log is OK, unmask + log is never OK).
- Anything from `.env` files.

**Edge case:** if an error MESSAGE from Viva contains PII (e.g., declined transaction message includes the customer's email), the adapter MUST scrub before constructing the envelope. Don't pass through.

---

## 12. Threat model summary

| Threat | Mitigation | Residual risk |
|---|---|---|
| Forged webhook events | IP allowlist + URL-verify + Retrieve-before-settle | Mid — requires Viva-source IP spoofing |
| Replay of valid webhook events | `MessageId` dedup via DB PK | Low |
| Token theft from logs / transcripts | Never-log-secrets discipline + log review | Low (depends on discipline) |
| Token theft from process memory dump | Out of scope — OS/container-level concern | — |
| Credential leak via `.env` exposure | Never-read-`.env` rule | Low |
| Cross-tenant data access (ISV) | `?merchantId=` scoping + `Channel.customFields.vivaMerchantId` unique constraint | Low — requires admin-level compromise |
| Admin endpoint abuse | Vendure `SuperAdmin` / Medusa `VIVA_ADMIN_TOKEN` | Low |
| Webhook receiver DoS | Stateless receiver (<100ms), idempotent dedup, rate limit at LB layer | Mid — Viva doesn't publish rate limits for inbound |
| Customer PII exposure in logs | Sanitization at envelope construction + receive-path discipline | Mid (depends on adapter logger config) |
| Forged Smart Checkout return URL params | Plugin reads order state from Viva via Retrieve, not from URL params | Low |

---

## 13. Reporting vulnerabilities

If you find a security issue in the plugin:

1. **Do not** open a public GitHub issue.
2. Contact the maintainer directly (private channel).
3. Provide: affected version, reproduction steps, observed behaviour, suggested mitigation if any.
4. Don't share PoC code publicly until a fix is shipped.

Plugin is pre-1.0; expect quick turnaround on security-class issues but no formal SLA.

---

## 14. References

- `docs/AUTH.md` — auth schemes + hosts (the "outbound" side)
- `docs/WEBHOOKS.md` §2 — webhook receiver auth detail
- `docs/ERRORS.md` §7 — logging discipline (error envelope path)
- `docs/GLOSSARY.md` — credential terminology
- `docs/ENDPOINTS.md` §10.4 — incoming webhook auth model
- `~/.claude/CLAUDE.md` "Secrets Hygiene" — global `.env` rule
- `references/viva-docs/md/oauth2-authentication.txt` — token endpoint
- `references/viva-docs/md/webhooks-for-payments.txt` — receiver verification flow

---

## 15. Changelog (this document)

- 2026-05-12 — initial. Webhook receiver auth (IP allowlist + URL verify, no HMAC), credential hygiene, PII handling in webhook bodies, tenant isolation in ISV mode, admin endpoint gating, PCI scope (SAQ A), threat model summary.
