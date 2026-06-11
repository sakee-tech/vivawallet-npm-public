# Viva Wallet Plugin — State Machine Reference

> Three coupled state machines: **Viva's `StatusId`** → **plugin's `viva_transaction.status`** → **storefront framework state** (Vendure `Payment.state` / Medusa `Payment.status`). One translation table, mandatory transition lattice, terminal-state rules.

---

## 1. The three layers

```
Viva API / webhooks
  └─ StatusId letter  (F, A, C, E, R, X, M, MA, MI, ML, MS, MW)
        │
        ▼  mapStatusLetter()  — pure mapping, no side effects
        │
plugin internal
  └─ viva_transaction.status  (initiated | authorized | captured | refunded | failed | cancelled | disputed)
        │
        ▼  adapter (Vendure / Medusa)
        │
storefront
  └─ Vendure Payment.state     (Created | Authorized | Settled | Cancelled | Declined | Error | Refunded)
     Medusa  Payment.status    (pending | authorized | captured | canceled | refunded | failed | requires_more)
```

Translation between layers is **monotonic forward** — once we're past `captured`, we don't revisit `authorized`. Lattice enforces this.

---

## 2. Viva `StatusId` → plugin status

Pure mapping. Source of truth: `packages/viva-payments-core/src/webhooks/status-lattice.ts` (`mapStatusLetter`).

| Viva letter | Plugin status | Claim substate | Notes |
|---|---|---|---|
| `F` | `captured` | — | Finished — successful payment capture |
| `A` | `authorized` | — | Auth-only (pre-auth, not captured yet) |
| `C` | `captured` | — | Captured (treated identically to `F`) |
| `E` | `failed` | — | Error / declined |
| `R` | `refunded` | — | Refunded |
| `X` | `cancelled` | — | Cancelled (void of auth, or user-cancel mid-checkout) |
| `M` | `disputed` | `M` | Generic claim/chargeback |
| `MA` | `disputed` | `MA` | Claim — awaiting response |
| `MI` | `disputed` | `MI` | Claim — in progress |
| `ML` | `disputed` | `ML` | Claim — lost |
| `MS` | `disputed` | `MS` | Suspected claim |
| `MW` | `disputed` | `MW` | Claim — won |

**Disambiguation:** `F` and `C` both map to `captured`. Plugin doesn't model the distinction (Viva uses `F` for the standard finish; `C` is rare and appears in some legacy/POS contexts).

**M-family:** All `M*` letters collapse to `disputed` with the original letter preserved in `viva_transaction.claim_substate`.

**Open Q:** The lettered `StatusId` for "customer clicked Cancel on Smart Checkout page" (event 4865) is not documented by Viva. Plugin defensively treats `{X, C, E}` as cancellation signals from 4865 — confirm + tighten on first live observation. Tracked in `process-viva-webhook.handler.ts:447` TODO.

---

## 3. Plugin status lattice

Allowed forward transitions on `viva_transaction.status`. Source of truth: `packages/viva-payments-core/src/webhooks/status-lattice.ts`.

```
initiated
  ├─→ authorized
  ├─→ captured
  └─→ failed

authorized
  ├─→ captured
  ├─→ cancelled    (A9 — void-before-capture)
  ├─→ failed
  └─→ disputed

captured
  ├─→ refunded
  └─→ disputed

refunded
  └─→ disputed

failed     → (terminal — no transitions)
cancelled  → (terminal — no transitions)
disputed   → (terminal — no transitions)
```

### Transition validator return types

Lookup function `validateStatusTransition(current, next)` returns one of:

| Result | Meaning |
|---|---|
| `{ ok: true, next }` | Allowed forward transition OR idempotent self-transition |
| `{ ok: false, reason: 'TERMINAL' }` | `current` is a terminal state; `next !== current` is rejected |
| `{ ok: false, reason: 'BACKWARD' }` | `next` is an ancestor of `current` in the DAG — explicit backward attempt |
| `{ ok: false, reason: 'ILLEGAL' }` | Cross-edge or unrelated state — never legal |

### Rule: idempotent self-transition

`current === next` is always `{ ok: true }`. This is critical for handling Viva's at-least-once delivery — a redelivered 1796 on an already-captured transaction is a no-op, not an error.

### Rule: terminal states never transition

`failed`, `cancelled`, `disputed` accept no outbound transitions. Once you're terminal, you stay there. A late 4865 cancel arriving after the order already settled (current = `captured`) is rejected as ILLEGAL — and that's the correct behaviour: do NOT roll back a captured payment because of a late cancel signal.

### Rule: `captured` is forward-reachable but not "terminal" by lattice

`captured` allows `→ refunded` and `→ disputed`. Don't confuse "terminal in storefront UX" (paid orders don't get touched) with "terminal in the lattice" (no outbound edges).

---

## 4. Adapter mapping — plugin status → storefront state

### 4.1 Vendure `Payment.state`

| Plugin status | Vendure state | Order state during transition |
|---|---|---|
| `initiated` | `Created` | `ArrangingPayment` |
| `authorized` | `Authorized` | `ArrangingPayment → PaymentAuthorized` |
| `captured` | `Settled` | `PaymentAuthorized → PaymentSettled` |
| `refunded` | `Refunded` | unchanged (Refunded is a Payment state, not an Order state) |
| `failed` | `Declined` | stays in `ArrangingPayment` (customer can retry) |
| `cancelled` | `Cancelled` | `ArrangingPayment → AddingItems` (customer can re-cart) OR `Cancelled` (if explicit) |
| `disputed` | `Settled` *(claim flagged via custom field)* | unchanged — chargeback is post-settlement |

The "settle on 1796" handler path is the most common:

```
viva_transaction.status:  initiated → captured
Vendure Payment.state:    Created  → Authorized → Settled
Vendure Order.state:      ArrangingPayment → PaymentAuthorized → PaymentSettled
```

Plugin walks both intermediate steps (Created → Authorized → Settled, not Created → Settled) because Vendure's PaymentService enforces the state machine. Going through the intermediate state is necessary.

### 4.2 Medusa `PaymentSessionStatus`

Verified against `packages/medusa-payment-viva/src/service.ts` (`toMedusaStatus` function ~line 163):

| Plugin status | Medusa `PaymentSessionStatus` | Notes |
|---|---|---|
| `initiated` | `pending` | |
| `authorized` | `authorized` | |
| `captured` | **`authorized`** | Medusa's `PaymentSessionStatus` enum has no `captured` value — plugin reports `authorized` after capture. The `viva_transaction.status='captured'` flag is the plugin-internal truth; Medusa's session stays at `authorized`. |
| `refunded` | `refunded` | |
| `failed` | `error` | |
| `cancelled` | `canceled` | American spelling on Medusa side |
| `disputed` | **`requires_more`** | Plugin uses Medusa's "needs more info" state to flag a dispute — operator must take action. Claim substate stored in `payment.metadata`. |

Medusa's payment model has fewer states than Vendure's — plugin uses `payment.metadata` for claim substate + dispute tracking.

---

## 5. Driving events

Which events cause which transitions:

| Event source | Action | Resulting transition |
|---|---|---|
| `createPayment()` (storefront `addPaymentToOrder`) | Plugin calls Viva `POST /checkout/v2/[isv/]orders`; writes `viva_transaction` row | `(none) → initiated` |
| Webhook `1796` (Payment Created) | Worker retrieves transaction, validates, settles | `initiated → captured` (or `authorized → captured` if pre-auth was used) |
| Webhook `1798` (Payment Failed) | Worker updates status | `initiated → failed` (terminal) |
| Webhook `1797` (Reversal Created) | Worker updates status | `captured → refunded` |
| Webhook `4865` (Order Updated, status=X/C/E) | Worker treats as user cancel | `initiated → cancelled` or `authorized → cancelled` |
| `cancelPayment()` mutation (Vendure) / equivalent (Medusa) | Plugin calls `DELETE /checkout/v2/orders/{orderCode}` AND transitions order to `AddingItems` | `initiated → cancelled` (synchronously) |
| `refundPayment()` admin call | Plugin calls Fast Refund or Standard refund | Doesn't change `viva_transaction.status` directly — waits for 1797 to confirm. (The refund row in `viva_transaction` is a separate child row in some adapter implementations.) |
| 1797 with claim substate (`M*` letter on retrieved transaction) | Worker updates status | `captured → disputed` or `refunded → disputed` |

---

## 6. Amount validation

Every settle path runs amount validation against the local `viva_transaction.amount_minor`:

```ts
if (vivaResponse.amount !== local.amount_minor) {
  throw VivaPluginError.amountMismatch(local.amount_minor, vivaResponse.amount);
  // → VIVA_AMOUNT_MISMATCH, processed_at stays NULL
}
```

Currency code mismatch is treated the same way (different code = different transaction). Plugin does NOT auto-correct.

Tip + surcharge are tracked separately:

| Local field | Wire field | Semantics |
|---|---|---|
| `viva_transaction.amount_minor` | `Amount` | total charged (incl. tip + surcharge) |
| `viva_transaction.tip_amount` | `TipAmount` | informational |
| `viva_transaction.surcharge_amount` | `SurchargeAmount` | informational |

Amount validation compares `Amount`, not the decomposition.

---

## 7. Stale-order re-walk

Vendure's automatic order sweeper can roll an order back to `AddingItems` if it sits in `ArrangingPayment` past a threshold (configurable per Vendure deployment). When this happens and a webhook arrives afterwards, the plugin needs to bring the order back to `PaymentSettled`.

Re-walk algorithm:

```
1. Current order state:        AddingItems
2. Re-trigger:                  AddingItems → ArrangingPayment       (via transitionToState)
3. Re-trigger:                  ArrangingPayment → PaymentAuthorized
4. Re-trigger:                  PaymentAuthorized → PaymentSettled
```

Each step is a single Vendure state transition. Plugin does not bypass the state machine — uses `OrderService.transitionToState` for each.

Conditions where re-walk is skipped:

- Order state has gone past `Cancelled` (no recovery — operator intervention).
- `viva_transaction.amount_minor` doesn't match the order's current `totalWithTax` (amount drifted; surface `VIVA_AMOUNT_MISMATCH`).

---

## 8. Backward / illegal transition logging

When `validateStatusTransition` returns `{ ok: false }`, the worker logs at level appropriate to the reason:

| Reason | Log level | Action |
|---|---|---|
| `TERMINAL` | INFO | Late event arrived after terminal state. Expected occasionally — Viva's at-least-once delivery means redelivered events can arrive after operator-initiated terminal transitions. |
| `BACKWARD` | WARN | Unexpected — Viva sent an event implying we should go backward. Investigate the specific transition. |
| `ILLEGAL` | ERROR | Bug or Viva-side anomaly. Surface as `VIVA_INTERNAL_ERROR` envelope in `viva_webhook_event.error`, leave `processed_at NULL`. |

The webhook event row is still marked `processed_at` for `TERMINAL` (we processed it; it's just a no-op). `BACKWARD` and `ILLEGAL` leave `processed_at NULL` for operator review.

---

## 9. Diagram — the canonical 1796 path

```
storefront                plugin                       Viva                worker            storefront DB
────────────────────────────────────────────────────────────────────────────────────────────────────────
   │
addPaymentToOrder ─────────▶ createPayment()
   │                            │
   │                            ├─▶ INSERT viva_transaction (status=initiated)
   │                            │
   │                            ├─▶ POST /checkout/v2/orders ─────────▶ Viva
   │                            │                                       │
   │                            ◀──── { orderCode } ────────────────────┤
   │                            │
   │  ◀── Payment{state=Created, metadata.redirectUrl}
   │
window.location = redirectUrl  ─────────────────────────────────────▶ Viva Smart Checkout
                                                                       │
                                                       customer pays ──┤
                                                                       │
                                                                       ▼
                                            POST /viva/webhook (1796) ─┐
   │                                                                   │
   │                            receiver: INSERT viva_webhook_event ◀──┤
   │                            (ON CONFLICT DO NOTHING)               │
   │                            enqueue job                            │
   │                            return 200 ─────────────────────────▶ Viva
   │                                                                   │
   │                                                            worker pickup
   │                                                                   │
   │                            GET /checkout/v2/transactions/{id} ────┤
   │                            ◀──── { statusId:'F', amount:9999 } ──┤
   │                                                                   │
   │                            mapStatusLetter('F') → captured        │
   │                            validateStatusTransition(initiated,    │
   │                                                     captured)→ok  │
   │                            UPDATE viva_transaction set            │
   │                              status='captured'                    │
   │                                                                   │
   │                            transitionToState ArrangingPayment →   │
   │                              PaymentAuthorized → PaymentSettled   │
   │                                                                   │
   │                            UPDATE viva_webhook_event set          │
   │                              processed_at=now()                   │
   │
navigate to /order-confirmation/{orderCode}
```

---

## 10. Adapter-specific notes

### 10.1 Vendure

- Plugin uses `OrderService.transitionToState` and `PaymentService.transitionToState` for every state change. Never raw DB writes.
- Custom field `vivaPayoutsEnabled` (ISV mode) acts as a gate on `createPayment` — when `false`, throws `VIVA_ACCOUNT_NOT_VERIFIED` before contacting Viva.
- `cancelPayment` Shop API mutation voids Viva-side AND transitions order back. Both must succeed; rollback if either fails.

### 10.2 Medusa

Verified against `packages/medusa-payment-viva/src/service.ts`:

- Plugin extends `AbstractPaymentProvider<VivaPaymentProviderOptions>` (`service.ts:32`).
- Lifecycle methods implemented: `initiatePayment` (`:336`), `authorizePayment` (`:486`), `capturePayment` (`:531`), `refundPayment` (`:593`), `cancelPayment` (`:713`), `retrievePayment` (`:782`), `getPaymentStatus` (`:823`), `deletePayment` (`:859`), `updatePayment` (`:881`).
- `getPaymentStatus` returns plugin status mapped to `PaymentSessionStatus` per §4.2 (`service.ts:838`).
- `viva_transaction` row creation is keyed by **`medusaPaymentId`** (derived from `input.context?.idempotency_key` or `input.data?.['session_id']` at `service.ts:408`). NOT a composite `(channelId, paymentSessionId)` key.

---

## 11. References

- `packages/viva-payments-core/src/webhooks/status-lattice.ts` — `mapStatusLetter` + `validateStatusTransition` + lattice definitions (source of truth)
- `packages/viva-payments-core/src/types/status.ts` — `VivaStatusLetter`, `VivaTransactionStatus`, `VivaClaimSubstate` type definitions
- `packages/*/src/jobs/process-viva-webhook.handler.ts` — adapter-specific event dispatch
- `docs/WEBHOOKS.md` — per-event payload reference
- `docs/ERRORS.md` — error envelope for failed transitions
- `docs/ENDPOINTS.md` §3 — retrieve-transaction response shape (source of `StatusId`)
- `references/viva-docs/md/wh-transaction-payment-created.txt:398` — Viva's `StatusId` reference table
- `references/viva-docs/md/wh-sale-transactions.txt:210` — claim substate documentation

---

## 12. Changelog (this document)

- 2026-05-12 — initial. Three-layer mapping (Viva → plugin → storefront), lattice from `status-lattice.ts`, adapter-specific notes, stale-order re-walk algorithm. Open Q on 4865 user-cancel `StatusId` letter still flagged.
