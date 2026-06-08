import { describe, it, expect } from 'vitest';
import { createHmac } from 'node:crypto';
import { verifyHmacSignature } from '../../src/webhooks/hmac-verify.js';
import { VivaWebhookError } from '../../src/errors/index.js';

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

const SECRET = 'test-secret-key';
const BODY = '{"Text":"https://example.com/file","Authorized":true}';

/** Build a valid Viva-Signature-256 hex digest for a given body + secret. */
function makeSignature(body: string | Uint8Array, secret: string): string {
  return createHmac('sha256', secret).update(body).digest('hex');
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('verifyHmacSignature', () => {
  it('does not throw for a valid signature (string body)', () => {
    const sig = makeSignature(BODY, SECRET);
    expect(() => verifyHmacSignature(BODY, sig, SECRET)).not.toThrow();
  });

  it('does not throw for a valid signature (Buffer body)', () => {
    const buf = Buffer.from(BODY, 'utf8');
    const sig = makeSignature(buf, SECRET);
    expect(() => verifyHmacSignature(buf, sig, SECRET)).not.toThrow();
  });

  it('throws VivaWebhookError for a tampered body', () => {
    const sig = makeSignature(BODY, SECRET);
    const tamperedBody = BODY + ' extra';
    expect(() => verifyHmacSignature(tamperedBody, sig, SECRET)).toThrow(VivaWebhookError);
    expect(() => verifyHmacSignature(tamperedBody, sig, SECRET)).toThrow('signature mismatch');
  });

  it('throws VivaWebhookError for a wrong secret', () => {
    const sig = makeSignature(BODY, 'wrong-secret');
    expect(() => verifyHmacSignature(BODY, sig, SECRET)).toThrow(VivaWebhookError);
    expect(() => verifyHmacSignature(BODY, sig, SECRET)).toThrow('signature mismatch');
  });

  it('throws VivaWebhookError for undefined signature', () => {
    expect(() => verifyHmacSignature(BODY, undefined, SECRET)).toThrow(VivaWebhookError);
    expect(() => verifyHmacSignature(BODY, undefined, SECRET)).toThrow('Missing');
  });

  it('throws VivaWebhookError for null signature', () => {
    expect(() => verifyHmacSignature(BODY, null, SECRET)).toThrow(VivaWebhookError);
    expect(() => verifyHmacSignature(BODY, null, SECRET)).toThrow('Missing');
  });

  it('throws VivaWebhookError for empty string signature', () => {
    expect(() => verifyHmacSignature(BODY, '', SECRET)).toThrow(VivaWebhookError);
    expect(() => verifyHmacSignature(BODY, '', SECRET)).toThrow('Missing');
  });

  it('throws VivaWebhookError for a non-hex signature (malformed)', () => {
    const nonHex = 'gggggggggggggggggggggggggggggggggggggggggggggggggggggggggggggggg';
    expect(() => verifyHmacSignature(BODY, nonHex, SECRET)).toThrow(VivaWebhookError);
    expect(() => verifyHmacSignature(BODY, nonHex, SECRET)).toThrow('Malformed');
  });

  it('throws VivaWebhookError for a base64 signature (wrong format)', () => {
    // Base64 of a 32-byte buffer — valid base64 but not hex.
    const b64 = Buffer.alloc(32).toString('base64');
    expect(() => verifyHmacSignature(BODY, b64, SECRET)).toThrow(VivaWebhookError);
  });

  it('throws VivaWebhookError for a length-mismatched candidate without RangeError', () => {
    // 60 hex chars = 30 bytes (shorter than 32 bytes expected for SHA-256).
    const shortSig = 'a'.repeat(60);
    let caught: unknown = null;
    try {
      verifyHmacSignature(BODY, shortSig, SECRET);
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(VivaWebhookError);
    // Must NOT be a Node-internal RangeError.
    expect(caught).not.toBeInstanceOf(RangeError);
    // Error message should describe the length mismatch.
    expect((caught as VivaWebhookError).message).toMatch(/length mismatch/i);
  });

  it('the code property is VIVA_WEBHOOK_ERROR', () => {
    const sig = makeSignature('wrong-body', SECRET);
    try {
      verifyHmacSignature(BODY, sig, SECRET);
    } catch (e) {
      expect((e as VivaWebhookError).code).toBe('VIVA_WEBHOOK_ERROR');
    }
  });
});
