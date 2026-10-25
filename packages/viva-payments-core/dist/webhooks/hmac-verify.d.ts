/**
 * HMAC-SHA256 signature verification for the Sale Transactions webhook (event 7936).
 *
 * PER PLAN A8: HMAC verification applies ONLY to event 7936 (Sale Transactions).
 * Viva does NOT document an HMAC header for any other v1 event type. For all
 * other events, security relies on:
 *   (a) IP allowlist — see ip-allowlist.ts
 *   (b) Challenge-response URL verification — see challenge-response.ts
 *   (c) DB-level deduplication via opaque MessageId (ON CONFLICT DO NOTHING)
 *
 * Header format (from Viva documentation):
 *   `Viva-Signature-256`: HMAC hex digest of the request body,
 *    generated using SHA-256 and the webhook secret as the HMAC key.
 *
 * @see references/viva-docs/md/wh-sale-transactions.txt:149
 */
/**
 * Verify the `Viva-Signature-256` header for the Sale Transactions webhook
 * (event 7936 only).
 *
 * Uses `crypto.timingSafeEqual` for constant-time comparison. Length mismatches
 * are handled without calling `timingSafeEqual` (which would throw on unequal
 * lengths) by comparing against a zeroed buffer of the same expected length.
 *
 * @param rawBody    The exact raw request body bytes received over the wire.
 *                   Pass a `Buffer` or `Uint8Array` for binary-safe comparison;
 *                   a `string` is accepted and UTF-8-encoded internally.
 * @param signature  Value of the `Viva-Signature-256` HTTP header.
 *                   Must be a lowercase hex digest (64 hex chars for SHA-256).
 * @param secret     HMAC secret from Viva configuration.
 *
 * @throws VivaWebhookError when the signature is missing, malformed, or does
 *   not match the computed digest.
 *
 * @see references/viva-docs/md/wh-sale-transactions.txt:149
 */
export declare function verifyHmacSignature(rawBody: Uint8Array | string, signature: string | undefined | null, secret: string): void;
//# sourceMappingURL=hmac-verify.d.ts.map