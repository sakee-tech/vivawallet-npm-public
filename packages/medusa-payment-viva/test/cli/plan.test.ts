/**
 * plan.test.ts — pure unit tests for computePlan().
 *
 * No IO, no network. All tests exercise the deterministic plan computation
 * logic in isolation.
 *
 * @see packages/medusa-payment-viva/src/cli/plan.ts
 */

import { describe, it, expect } from 'vitest';
import { computePlan } from '../../src/cli/plan.js';
import type { DesiredWebhook, WebhookPlanAction } from '../../src/cli/types.js';
import type { WebhookRegistration } from '@sakeetech/viva-payments-core/types';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const BASE_URL = 'https://api.example.com/viva/webhook';

/** Build a DesiredWebhook for the given eventTypeId pointing at BASE_URL. */
function desired(eventTypeId: number): DesiredWebhook {
  return { eventTypeId: eventTypeId as DesiredWebhook['eventTypeId'], url: BASE_URL };
}

/** Build a WebhookRegistration for the given eventTypeId + url. */
function reg(eventTypeId: number, url: string = BASE_URL, webhookId?: string): WebhookRegistration {
  return { eventTypeId, url, isActive: true, ...(webhookId ? { webhookId } : {}) };
}

/** V1 event type IDs in order. */
const V1_IDS = [1796, 1797, 1798, 4865, 8193, 8194] as const;

function v1Desired(): DesiredWebhook[] {
  return V1_IDS.map((id) => desired(id));
}

// ---------------------------------------------------------------------------
// 1. Empty current, 6 desired → 6 REGISTER in eventTypeId order
// ---------------------------------------------------------------------------

describe('computePlan', () => {
  it('1 — empty current, 6 desired → 6 REGISTER in eventTypeId order', () => {
    const plan = computePlan({ desired: v1Desired(), current: [] });
    const registers = plan.actions.filter((a) => a.kind === 'REGISTER');
    expect(registers).toHaveLength(6);
    expect(plan.hasFatalError).toBe(false);

    // Verify eventTypeId ordering.
    const ids = registers.map((a) => (a as Extract<WebhookPlanAction, { kind: 'REGISTER' }>).desired.eventTypeId);
    expect(ids).toEqual([...ids].sort((a, b) => a - b));
    expect(ids).toEqual([1796, 1797, 1798, 4865, 8193, 8194]);
  });

  // ---------------------------------------------------------------------------
  // 2. Half-registered: 3 of 6 already present → 3 SKIP + 3 REGISTER
  // ---------------------------------------------------------------------------

  it('2 — half-registered: 3 already present → 3 SKIP + 3 REGISTER', () => {
    const current: WebhookRegistration[] = [
      reg(1796),
      reg(1797),
      reg(1798),
    ];
    const plan = computePlan({ desired: v1Desired(), current });

    const registers = plan.actions.filter((a) => a.kind === 'REGISTER');
    const skips = plan.actions.filter((a) => a.kind === 'SKIP_ALREADY_REGISTERED');
    expect(registers).toHaveLength(3);
    expect(skips).toHaveLength(3);
    expect(plan.hasFatalError).toBe(false);
  });

  // ---------------------------------------------------------------------------
  // 3. All registered, none drifted → 6 SKIP, no REGISTER
  // ---------------------------------------------------------------------------

  it('3 — all registered → 6 SKIP, no REGISTER', () => {
    const current: WebhookRegistration[] = V1_IDS.map((id) => reg(id));
    const plan = computePlan({ desired: v1Desired(), current });

    expect(plan.actions.every((a) => a.kind === 'SKIP_ALREADY_REGISTERED')).toBe(true);
    expect(plan.actions).toHaveLength(6);
    expect(plan.hasFatalError).toBe(false);
  });

  // ---------------------------------------------------------------------------
  // 4. At-limit: 1796 has 10 registrations → ABORT_LIMIT_HIT for 1796,
  //    REGISTER for the other 5, hasFatalError=true
  // ---------------------------------------------------------------------------

  it('4 — at-limit: 1796 has 10 registrations → ABORT_LIMIT_HIT + 5 REGISTER, hasFatalError=true', () => {
    const atLimit: WebhookRegistration[] = Array.from({ length: 10 }, (_, i) =>
      reg(1796, `https://other${i}.example.com/webhook`),
    );
    const plan = computePlan({ desired: v1Desired(), current: atLimit });

    const aborts = plan.actions.filter((a) => a.kind === 'ABORT_LIMIT_HIT');
    const registers = plan.actions.filter((a) => a.kind === 'REGISTER');
    expect(aborts).toHaveLength(1);
    const abort = aborts[0] as Extract<WebhookPlanAction, { kind: 'ABORT_LIMIT_HIT' }>;
    expect(abort.eventTypeId).toBe(1796);
    expect(abort.current).toBe(10);
    expect(abort.limit).toBe(10);
    // The other 5 event types should still be REGISTER.
    expect(registers).toHaveLength(5);
    expect(plan.hasFatalError).toBe(true);
  });

  // ---------------------------------------------------------------------------
  // 5. Near-limit: 1796 has 8 registrations (fraction 0.8 of 10)
  //    → WARN_LIMIT_NEAR + REGISTER (still proceeds)
  // ---------------------------------------------------------------------------

  it('5 — near-limit: 1796 has 8 registrations → WARN_LIMIT_NEAR + REGISTER', () => {
    const nearLimit: WebhookRegistration[] = Array.from({ length: 8 }, (_, i) =>
      reg(1796, `https://other${i}.example.com/webhook`),
    );
    const plan = computePlan({ desired: v1Desired(), current: nearLimit });

    const warns = plan.actions.filter((a) => a.kind === 'WARN_LIMIT_NEAR');
    const registers = plan.actions.filter(
      (a) => a.kind === 'REGISTER' &&
        (a as Extract<WebhookPlanAction, { kind: 'REGISTER' }>).desired.eventTypeId === 1796,
    );
    expect(warns).toHaveLength(1);
    const warn = warns[0] as Extract<WebhookPlanAction, { kind: 'WARN_LIMIT_NEAR' }>;
    expect(warn.eventTypeId).toBe(1796);
    expect(warn.current).toBe(8);
    // REGISTER for 1796 still emitted.
    expect(registers).toHaveLength(1);
    expect(plan.hasFatalError).toBe(false);
  });

  // ---------------------------------------------------------------------------
  // 6. Drift reconciliation ON: desired=[1796→A], current=[1796→A, 1796→B(drift)]
  //    B matches ownedHostnamePattern → DEACTIVATE_DRIFT for B
  // ---------------------------------------------------------------------------

  it('6 — drift reconciliation on: drifted URL deactivated', () => {
    const urlA = 'https://api.example.com/viva/webhook';
    const urlB = 'https://api.example.com/old/webhook';
    const current: WebhookRegistration[] = [
      reg(1796, urlA, 'wh-a'),
      reg(1796, urlB, 'wh-b'),
    ];
    const plan = computePlan({
      desired: [{ eventTypeId: 1796, url: urlA }],
      current,
      reconcileDrift: true,
      ownedHostnamePattern: /api\.example\.com/,
    });

    const deactivate = plan.actions.filter((a) => a.kind === 'DEACTIVATE_DRIFT');
    expect(deactivate).toHaveLength(1);
    const d = deactivate[0] as Extract<WebhookPlanAction, { kind: 'DEACTIVATE_DRIFT' }>;
    expect(d.existing.url).toBe(urlB);
    expect(d.reason).toBe('URL_NOT_IN_DESIRED');
    // urlA is already registered → SKIP
    const skips = plan.actions.filter((a) => a.kind === 'SKIP_ALREADY_REGISTERED');
    expect(skips).toHaveLength(1);
    expect(plan.hasFatalError).toBe(false);
  });

  // ---------------------------------------------------------------------------
  // 7. Drift reconciliation OFF: same as 6, no DEACTIVATE actions
  // ---------------------------------------------------------------------------

  it('7 — drift reconciliation off: drifted URL NOT deactivated', () => {
    const urlA = 'https://api.example.com/viva/webhook';
    const urlB = 'https://api.example.com/old/webhook';
    const current: WebhookRegistration[] = [
      reg(1796, urlA, 'wh-a'),
      reg(1796, urlB, 'wh-b'),
    ];
    const plan = computePlan({
      desired: [{ eventTypeId: 1796, url: urlA }],
      current,
      reconcileDrift: false,
    });

    const deactivate = plan.actions.filter((a) => a.kind === 'DEACTIVATE_DRIFT');
    expect(deactivate).toHaveLength(0);
  });

  // ---------------------------------------------------------------------------
  // 8. Stable ordering: shuffled input produces the same output
  // ---------------------------------------------------------------------------

  it('8 — stable ordering: shuffled inputs produce same plan as sorted inputs', () => {
    const shuffledDesired: DesiredWebhook[] = [
      desired(8194), desired(4865), desired(1796), desired(8193), desired(1798), desired(1797),
    ];
    const shuffledCurrent: WebhookRegistration[] = [
      reg(1797), reg(8193),
    ];

    const planShuffled = computePlan({
      desired: shuffledDesired,
      current: shuffledCurrent,
    });
    const planSorted = computePlan({
      desired: v1Desired(),
      current: [reg(1797), reg(8193)],
    });

    // Both should have same number of REGISTER + SKIP actions.
    const registersShuffled = planShuffled.actions.filter((a) => a.kind === 'REGISTER').map(
      (a) => (a as Extract<WebhookPlanAction, { kind: 'REGISTER' }>).desired.eventTypeId,
    );
    const registersSorted = planSorted.actions.filter((a) => a.kind === 'REGISTER').map(
      (a) => (a as Extract<WebhookPlanAction, { kind: 'REGISTER' }>).desired.eventTypeId,
    );
    expect(registersShuffled).toEqual(registersSorted);

    const skipsShuffled = planShuffled.actions.filter((a) => a.kind === 'SKIP_ALREADY_REGISTERED').map(
      (a) => (a as Extract<WebhookPlanAction, { kind: 'SKIP_ALREADY_REGISTERED' }>).existing.eventTypeId,
    );
    const skipsSorted = planSorted.actions.filter((a) => a.kind === 'SKIP_ALREADY_REGISTERED').map(
      (a) => (a as Extract<WebhookPlanAction, { kind: 'SKIP_ALREADY_REGISTERED' }>).existing.eventTypeId,
    );
    expect(skipsShuffled).toEqual(skipsSorted);
  });
});
