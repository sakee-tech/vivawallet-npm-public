"use strict";
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
Object.defineProperty(exports, "__esModule", { value: true });
exports.verifyHmacSignature = verifyHmacSignature;
const node_crypto_1 = require("node:crypto");
const index_js_1 = require("../errors/index.js");
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
function verifyHmacSignature(rawBody, signature, secret) {
    // --- 1. Guard: signature header must be present and non-empty ---
    if (signature == null || signature.length === 0) {
        throw new index_js_1.VivaWebhookError({
            message: 'Missing Viva-Signature-256 header. This header is required for event 7936 (Sale Transactions).',
        });
    }
    // --- 2. Decode candidate hex string to bytes ---
    // The header value is a hex digest per wh-sale-transactions.txt:149.
    // A SHA-256 hex digest is always exactly 64 hex characters (32 bytes).
    const expectedByteLength = 32; // SHA-256 output is 32 bytes
    const hexRegex = /^[0-9a-f]+$/i;
    if (!hexRegex.test(signature)) {
        throw new index_js_1.VivaWebhookError({
            message: `Malformed Viva-Signature-256 header: not a valid hex string. Received: "${signature.slice(0, 20)}..."`,
        });
    }
    let candidateBuffer;
    try {
        candidateBuffer = Buffer.from(signature, 'hex');
    }
    catch {
        throw new index_js_1.VivaWebhookError({
            message: 'Malformed Viva-Signature-256 header: hex decode failed.',
        });
    }
    // --- 3. Compute expected HMAC-SHA256 ---
    const hmac = (0, node_crypto_1.createHmac)('sha256', secret);
    hmac.update(rawBody);
    const expectedBuffer = hmac.digest(); // returns a Buffer (32 bytes)
    // --- 4. Constant-time comparison ---
    // timingSafeEqual requires both buffers to have the same length.
    // If candidateBuffer.length !== expectedByteLength, we still do a
    // constant-time comparison against a zeroed buffer to avoid timing leaks,
    // then unconditionally throw.
    if (candidateBuffer.length !== expectedByteLength) {
        // Compare candidate against a zero buffer of the expected length.
        // This runs in constant time relative to expectedByteLength.
        const zeros = Buffer.alloc(expectedByteLength, 0);
        // We deliberately ignore the result here — length mismatch is always a fail.
        void (0, node_crypto_1.timingSafeEqual)(zeros, expectedBuffer);
        throw new index_js_1.VivaWebhookError({
            message: `Viva-Signature-256 header length mismatch: expected ${expectedByteLength} bytes (${expectedByteLength * 2} hex chars), got ${candidateBuffer.length} bytes.`,
        });
    }
    // Both buffers are 32 bytes — safe to call timingSafeEqual.
    const valid = (0, node_crypto_1.timingSafeEqual)(expectedBuffer, candidateBuffer);
    if (!valid) {
        throw new index_js_1.VivaWebhookError({
            message: 'Viva-Signature-256 signature mismatch. Request body may have been tampered with.',
        });
    }
}
//# sourceMappingURL=hmac-verify.js.map