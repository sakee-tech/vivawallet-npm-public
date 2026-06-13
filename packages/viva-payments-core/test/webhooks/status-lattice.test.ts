import { describe, it, expect } from 'vitest';
import { mapStatusLetter, validateStatusTransition } from '../../src/webhooks/status-lattice.js';
import type { VivaStatusLetter, VivaTransactionStatus } from '../../src/types/status.js';

// ---------------------------------------------------------------------------
// mapStatusLetter
// ---------------------------------------------------------------------------

describe('mapStatusLetter', () => {
  it('maps F (Finished) → captured with null claimSubstate', () => {
    expect(mapStatusLetter('F')).toEqual({ status: 'captured', claimSubstate: null });
  });

  it('maps A (Active) → authorized with null claimSubstate', () => {
    expect(mapStatusLetter('A')).toEqual({ status: 'authorized', claimSubstate: null });
  });

  it('maps C (Captured) → captured with null claimSubstate', () => {
    expect(mapStatusLetter('C')).toEqual({ status: 'captured', claimSubstate: null });
  });

  it('maps E (Error) → failed with null claimSubstate', () => {
    expect(mapStatusLetter('E')).toEqual({ status: 'failed', claimSubstate: null });
  });

  it('maps R (Refunded) → refunded with null claimSubstate', () => {
    expect(mapStatusLetter('R')).toEqual({ status: 'refunded', claimSubstate: null });
  });

  it('maps X (Cancelled) → cancelled with null claimSubstate', () => {
    expect(mapStatusLetter('X')).toEqual({ status: 'cancelled', claimSubstate: null });
  });

  it('maps M (Claimed) → disputed with claimSubstate M', () => {
    expect(mapStatusLetter('M')).toEqual({ status: 'disputed', claimSubstate: 'M' });
  });

  it('maps MA (Claim Awaiting Response) → disputed with claimSubstate MA', () => {
    expect(mapStatusLetter('MA')).toEqual({ status: 'disputed', claimSubstate: 'MA' });
  });

  it('maps MI (Claim In Progress) → disputed with claimSubstate MI', () => {
    expect(mapStatusLetter('MI')).toEqual({ status: 'disputed', claimSubstate: 'MI' });
  });

  it('maps ML (Claim Lost) → disputed with claimSubstate ML', () => {
    expect(mapStatusLetter('ML')).toEqual({ status: 'disputed', claimSubstate: 'ML' });
  });

  it('maps MS (Suspected Claimed) → disputed with claimSubstate MS', () => {
    expect(mapStatusLetter('MS')).toEqual({ status: 'disputed', claimSubstate: 'MS' });
  });

  it('maps MW (Claim Won) → disputed with claimSubstate MW', () => {
    expect(mapStatusLetter('MW')).toEqual({ status: 'disputed', claimSubstate: 'MW' });
  });
});

// ---------------------------------------------------------------------------
// validateStatusTransition — legal transitions
// ---------------------------------------------------------------------------

describe('validateStatusTransition — legal transitions', () => {
  const legal: Array<[VivaTransactionStatus, VivaTransactionStatus]> = [
    ['initiated', 'authorized'],
    ['initiated', 'captured'],
    ['initiated', 'failed'],
    ['authorized', 'captured'],
    ['authorized', 'failed'],
    ['authorized', 'disputed'],
    ['captured', 'refunded'],
    ['captured', 'disputed'],
    ['refunded', 'disputed'],
  ];

  for (const [current, next] of legal) {
    it(`${current} → ${next} returns ok:true`, () => {
      const result = validateStatusTransition(current, next);
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.next).toBe(next);
      }
    });
  }

  // A9: authorized → cancelled must be allowed (void-before-capture).
  it('A9: authorized → cancelled returns { ok: true } (void-before-capture)', () => {
    const result = validateStatusTransition('authorized', 'cancelled');
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.next).toBe('cancelled');
    }
  });

  // Idempotent self-transitions.
  it('self-transition captured → captured returns { ok: true } (idempotent)', () => {
    const result = validateStatusTransition('captured', 'captured');
    expect(result.ok).toBe(true);
  });

  it('self-transition failed → failed returns { ok: true } (idempotent)', () => {
    const result = validateStatusTransition('failed', 'failed');
    expect(result.ok).toBe(true);
  });

  it('self-transition disputed → disputed returns { ok: true } (idempotent)', () => {
    const result = validateStatusTransition('disputed', 'disputed');
    expect(result.ok).toBe(true);
  });

  // A7 (authorized → disputed): cross-check disputed reachability.
  it('authorized → disputed returns { ok: true }', () => {
    const result = validateStatusTransition('authorized', 'disputed');
    expect(result.ok).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// validateStatusTransition — BACKWARD rejections
// ---------------------------------------------------------------------------

describe('validateStatusTransition — BACKWARD', () => {
  it('captured → initiated returns { ok: false, reason: BACKWARD }', () => {
    const result = validateStatusTransition('captured', 'initiated');
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe('BACKWARD');
      expect(result.current).toBe('captured');
      expect(result.attempted).toBe('initiated');
    }
  });

  it('refunded → captured returns { ok: false, reason: BACKWARD }', () => {
    const result = validateStatusTransition('refunded', 'captured');
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe('BACKWARD');
    }
  });

  it('captured → authorized returns { ok: false, reason: BACKWARD }', () => {
    const result = validateStatusTransition('captured', 'authorized');
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe('BACKWARD');
    }
  });
});

// ---------------------------------------------------------------------------
// validateStatusTransition — TERMINAL rejections
// ---------------------------------------------------------------------------

describe('validateStatusTransition — TERMINAL', () => {
  it('failed → captured returns { ok: false, reason: TERMINAL }', () => {
    const result = validateStatusTransition('failed', 'captured');
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe('TERMINAL');
      expect(result.current).toBe('failed');
      expect(result.attempted).toBe('captured');
    }
  });

  it('cancelled → refunded returns { ok: false, reason: TERMINAL }', () => {
    const result = validateStatusTransition('cancelled', 'refunded');
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe('TERMINAL');
      expect(result.current).toBe('cancelled');
      expect(result.attempted).toBe('refunded');
    }
  });

  it('cancelled → captured returns { ok: false, reason: TERMINAL }', () => {
    const result = validateStatusTransition('cancelled', 'captured');
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe('TERMINAL');
    }
  });

  it('disputed → authorized returns { ok: false, reason: TERMINAL }', () => {
    const result = validateStatusTransition('disputed', 'authorized');
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe('TERMINAL');
    }
  });
});

// ---------------------------------------------------------------------------
// validateStatusTransition — ILLEGAL (cross-edge)
// ---------------------------------------------------------------------------

describe('validateStatusTransition — ILLEGAL', () => {
  it('initiated → refunded returns { ok: false, reason: ILLEGAL }', () => {
    const result = validateStatusTransition('initiated', 'refunded');
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe('ILLEGAL');
    }
  });

  it('initiated → cancelled returns { ok: false, reason: ILLEGAL }', () => {
    const result = validateStatusTransition('initiated', 'cancelled');
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe('ILLEGAL');
    }
  });
});
