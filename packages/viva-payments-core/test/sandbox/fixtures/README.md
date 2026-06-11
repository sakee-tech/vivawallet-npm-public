# Sandbox Fixtures

Static JSON files representing real Viva demo API responses and webhook envelopes.
Used by undici MockAgent in unit tests. No live network calls at test time.

## Structure

```
fixtures/
  isv/        — Viva ISV REST API responses (OAuth token, createOrder, retrieve, refund, cancel, webhooks)
  webhooks/   — Viva webhook POST envelopes (EventTypeId 1796, 1797, 1798, 4865, 7936, 8193, 8194)
```

## Fixture shape convention

Every fixture contains a `_meta` block alongside the actual API data:

```json
{
  "_meta": {
    "scenario": "human-readable description",
    "doc_ref": "references/viva-docs/md/<file>.txt:<line>",
    "captured_at": "YYYY-MM-DD",
    "notes": "any caveats, TODOs, or unit assumptions"
  },
  "<actual_field>": "<actual_value>"
}
```

For the HMAC fixture (`webhooks/envelope-7936-sale-transactions-with-hmac.json`),
the top-level shape is:
```json
{
  "_meta": { ... },
  "rawBody": "<exact JSON string that was HMAC-signed>",
  "signatureHex": "<hex digest>",
  "testSecret": "test-secret",
  "envelope": { ... }
}
```

Load HMAC fixtures via `loadHmacFixture(name)` in `fixtures-loader.ts`.

## Amount unit assumption (P15-pending-verification)

All `Amount` fields in these fixtures use **integer minor units** (e.g. `9999` = EUR 99.99).
Viva's wire format for createOrder uses integer minor units. The RetrieveTransaction
API docs show `Amount: decimal`, but sample payloads show integer values.
Verify against the first live demo payment and update fixtures if needed.

## OrderCode precision

`OrderCode` in `isv/create-order-success.json` is `"9999999999999999"` (16 digits, stored
as JSON string in the fixture). This value exceeds `Number.MAX_SAFE_INTEGER`
(`9007199254740991`): `9999999999999999 > 9007199254740991`. The `IsvHttpClient` bigint-safe
JSON reviver parses it as `bigint`. Tests verify the round-trip by asserting
`typeof orderCode === 'bigint'` and `orderCode > BigInt(Number.MAX_SAFE_INTEGER) === true`.

## How to refresh fixtures against Viva demo

Fixtures are static; they represent expected shapes, not live captures. To update them:

1. **Obtain demo credentials**: follow `references/viva-docs/md/isv-credentials.txt` to
   get a demo client_id + client_secret.

2. **Run a manual end-to-end**: per plan P10, one manual e2e test per release:
   ```bash
   # Fetch a real token
   curl -X POST https://demo-accounts.vivapayments.com/connect/token \
     -H "Content-Type: application/x-www-form-urlencoded" \
     -d "grant_type=client_credentials&client_id=<ID>&client_secret=<SECRET>"

   # Create an order
   curl -X POST "https://demo-api.vivapayments.com/checkout/v2/orders?merchantId=<MERCHANT_ID>" \
     -H "Authorization: Bearer <TOKEN>" \
     -H "Content-Type: application/json" \
     -d '{"amount":9999,"currencyCode":978}'
   ```

3. **Capture the responses** and update the relevant fixture JSON files.

4. **Recompute HMAC** for the 7936 fixture:
   ```js
   const crypto = require('node:crypto');
   const rawBody = JSON.stringify(envelope); // exact wire body
   const sig = crypto.createHmac('sha256', secret).update(rawBody).digest('hex');
   ```
   Update `rawBody`, `signatureHex`, and `testSecret` in
   `webhooks/envelope-7936-sale-transactions-with-hmac.json`.

5. **Update `captured_at`** in each `_meta` block to today's date.

6. Run `pnpm -r test` to confirm all sandbox tests still pass.
