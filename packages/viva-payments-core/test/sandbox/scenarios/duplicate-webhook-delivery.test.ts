/**
 * duplicate-webhook-delivery.test.ts — Core-only: in-memory lattice idempotency.
 *
 * Tests the status lattice handles repeated applications of the same StatusId
 * gracefully. The DB-level dedup via ON CONFLICT(message_id) is exercised in
 * S8's tests; this test focuses on the pure in-memory lattice idempotency.
 *
 * Covers:
 *   1. Apply initiated → captured (StatusId=F). Verify ok=true, next='captured'.
 *   2. Re-apply same transition (captured → captured): idempotent, ok=true.
 *   3. Apply a different StatusId that maps to the same target status: still ok=true (idempotent).
 *   4. Fixture envelope-1796-duplicate-message-id has same MessageId as envelope-1796: confirmed.
 *
 * @see Plan P14 (webhook dedup — DB level + lattice idempotency)
 * @see references/viva-docs/md/wh-transaction-payment-created.txt:398 (StatusId letters)
 */

import { describe, it, expect } from 'vitest';
import { mapStatusLetter, validateStatusTransition } from '../../../src/webhooks/status-lattice.js';
import type { VivaTransactionStatus } from '../../../src/types/status.js';
import { loadFixture } from '../fixtures-loader.js';

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('sandbox/duplicate-webhook-delivery (core-only, no HTTP)', () => {
  // ---- Fixture dedup check ----

  it('envelope-1796-duplicate-message-id has the same MessageId as envelope-1796-payment-created', () => {
    const original = loadFixture<{ MessageId: string }>('webhooks', 'envelope-1796-payment-created');
    const duplicate = loadFixture<{ MessageId: string }>('webhooks', 'envelope-1796-duplicate-message-id');
    expect(duplicate.MessageId).toBe(original.MessageId);
  });

  it('envelope-1796-duplicate-message-id has RetryCount=1 (retry delivery marker)', () => {
    const duplicate = loadFixture<{ RetryCount: number }>('webhooks', 'envelope-1796-duplicate-message-id');
    expect(duplicate.RetryCount).toBe(1);
  });

  // ---- Lattice idempotency ----

  it('step 1: initiated → captured applies ok (StatusId=F, first delivery)', () => {
    const { status } = mapStatusLetter('F');
    expect(status).toBe('captured');

    const result = validateStatusTransition('initiated', status);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.next).toBe('captured');
    }
  });

  it('step 2: captured → captured idempotent re-apply returns ok=true (same StatusId re-delivered)', () => {
    const current: VivaTransactionStatus = 'captured';
    const { status } = mapStatusLetter('F');
    expect(status).toBe('captured');

    // Idempotent: same → same always ok
    const result = validateStatusTransition(current, status);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.next).toBe('captured');
    }
  });

  it('step 3: captured → captured via StatusId=C (also maps to captured) — idempotent ok=true', () => {
    const current: VivaTransactionStatus = 'captured';
    // StatusId=C also maps to 'captured' per P17
    const { status } = mapStatusLetter('C');
    expect(status).toBe('captured');

    const result = validateStatusTransition(current, status);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.next).toBe('captured');
    }
  });

  // ---- All StatusIds that map to captured are idempotent when already at captured ----

  it('all StatusIds that map to captured are idempotent when current=captured', () => {
    const captureLetters = ['F', 'C'] as const;
    for (const letter of captureLetters) {
      const { status } = mapStatusLetter(letter);
      expect(status).toBe('captured');
      const result = validateStatusTransition('captured', status);
      expect(result.ok).toBe(true);
    }
  });

  // ---- confirmed correct lattice shape ----

  it('authorized → captured is allowed (happy path via 1796)', () => {
    const { status } = mapStatusLetter('F');
    const result = validateStatusTransition('authorized', status);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.next).toBe('captured');
    }
  });
});
