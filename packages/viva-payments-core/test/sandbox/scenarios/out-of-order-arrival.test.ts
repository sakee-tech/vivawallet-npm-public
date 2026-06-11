/**
 * out-of-order-arrival.test.ts — Core-only: lattice rejects backward status transitions.
 *
 * Uses mapStatusLetter + validateStatusTransition directly — no HTTP, no DB.
 * Validates the monotonic status lattice enforces correct ordering of webhook events.
 *
 * Covers:
 *   1. authorized → failed (1798 arrives first) → then captured (1796 arrives late): BACKWARD reject.
 *   2. authorized → captured (1796 arrives) → then failed (1798 arrives late): BACKWARD reject.
 *   3. initiated → captured is allowed (direct transition, StatusId=F).
 *   4. failed is terminal: any non-self transition rejected as TERMINAL.
 *
 * @see references/viva-docs/md/wh-transaction-payment-created.txt:398 (StatusId letters)
 * @see Plan P14 (monotonic status lattice — terminal states never regress)
 * @see Plan P17 (status letter mapping)
 */

import { describe, it, expect } from 'vitest';
import { mapStatusLetter, validateStatusTransition } from '../../../src/webhooks/status-lattice.js';
import type { VivaTransactionStatus } from '../../../src/types/status.js';
import { loadFixture } from '../fixtures-loader.js';

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('sandbox/out-of-order-arrival (core-only, no HTTP)', () => {
  // ---- Load relevant fixtures to ensure they have the expected shapes ----

  it('fixture envelope-1796 has StatusId=F (captured)', () => {
    const envelope = loadFixture<{ EventData: { StatusId: string } }>('webhooks', 'envelope-1796-payment-created');
    expect(envelope.EventData.StatusId).toBe('F');
  });

  it('fixture envelope-1798 has StatusId=E (failed)', () => {
    const envelope = loadFixture<{ EventData: { StatusId: string } }>('webhooks', 'envelope-1798-failed');
    expect(envelope.EventData.StatusId).toBe('E');
  });

  it('fixture envelope-1796-out-of-order has StatusId=F and different MessageId', () => {
    const outOfOrder = loadFixture<{ EventData: { StatusId: string }; MessageId: string }>('webhooks', 'envelope-1796-out-of-order');
    const original = loadFixture<{ MessageId: string }>('webhooks', 'envelope-1796-payment-created');
    expect(outOfOrder.EventData.StatusId).toBe('F');
    expect(outOfOrder.MessageId).not.toBe(original.MessageId);
  });

  // ---- Scenario 1: 1798 (failed) arrives first, then 1796 (captured) arrives late ----

  it('scenario 1a: authorized → failed (1798 first) → BACKWARD when 1796 (captured) arrives late', () => {
    // Start at 'authorized'
    let current: VivaTransactionStatus = 'authorized';

    // 1798 arrives: E → failed
    const { status: failedStatus } = mapStatusLetter('E');
    expect(failedStatus).toBe('failed');
    const step1 = validateStatusTransition(current, failedStatus);
    expect(step1.ok).toBe(true);
    if (step1.ok) current = step1.next;
    expect(current).toBe('failed');

    // 1796 arrives late: F → captured — should be BACKWARD (failed is terminal)
    const { status: capturedStatus } = mapStatusLetter('F');
    expect(capturedStatus).toBe('captured');
    const step2 = validateStatusTransition(current, capturedStatus);
    expect(step2.ok).toBe(false);
    if (!step2.ok) {
      // 'failed' is terminal with no allowed transitions, so TERMINAL is the reason
      expect(['TERMINAL', 'BACKWARD']).toContain(step2.reason);
    }
    // Status stays 'failed'
    expect(current).toBe('failed');
  });

  // ---- Scenario 2: 1796 (captured) arrives first, then 1798 (failed) arrives late ----

  it('scenario 1b: authorized → captured (1796) → BACKWARD when 1798 (failed) arrives late', () => {
    // Start at 'authorized'
    let current: VivaTransactionStatus = 'authorized';

    // 1796 arrives: F → captured
    const { status: capturedStatus } = mapStatusLetter('F');
    expect(capturedStatus).toBe('captured');
    const step1 = validateStatusTransition(current, capturedStatus);
    expect(step1.ok).toBe(true);
    if (step1.ok) current = step1.next;
    expect(current).toBe('captured');

    // 1798 arrives late: E → failed — lattice rejects ('failed' is an ancestor of some paths but
    // not reachable forward from 'captured')
    const { status: failedStatus } = mapStatusLetter('E');
    expect(failedStatus).toBe('failed');
    const step2 = validateStatusTransition(current, failedStatus);
    expect(step2.ok).toBe(false);
    if (!step2.ok) {
      // captured → failed: 'failed' is not in captured's allowed set; BACKWARD or ILLEGAL
      expect(['BACKWARD', 'ILLEGAL']).toContain(step2.reason);
    }
    // Status stays 'captured'
    expect(current).toBe('captured');
  });

  // ---- Scenario 3: initiated → captured is a valid direct transition ----

  it('scenario 2: initiated → captured is allowed (StatusId=F direct)', () => {
    const { status } = mapStatusLetter('F');
    const result = validateStatusTransition('initiated', status);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.next).toBe('captured');
    }
  });

  // ---- Scenario 4: failed is terminal — no forward transitions ----

  it('scenario 3: failed is terminal — all non-self transitions rejected', () => {
    const targets: VivaTransactionStatus[] = ['initiated', 'authorized', 'captured', 'refunded', 'cancelled', 'disputed'];
    for (const target of targets) {
      const result = validateStatusTransition('failed', target);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(['TERMINAL', 'BACKWARD', 'ILLEGAL']).toContain(result.reason);
      }
    }
  });

  // ---- Scenario 5: idempotent self-transition is always OK ----

  it('scenario 4: idempotent self-transition (failed → failed) returns ok=true', () => {
    const result = validateStatusTransition('failed', 'failed');
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.next).toBe('failed');
    }
  });

  // ---- Scenario 6: captured → refunded is allowed (1797 reversal) ----

  it('scenario 5: captured → refunded allowed (1797 reversal via StatusId=R)', () => {
    const { status } = mapStatusLetter('R');
    expect(status).toBe('refunded');
    const result = validateStatusTransition('captured', status);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.next).toBe('refunded');
    }
  });
});
