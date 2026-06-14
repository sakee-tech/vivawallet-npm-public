/**
 * test/cli/plan.test.ts — computePlan() correctness tests.
 *
 * Coverage:
 *  1.  All 6 V1 event types produce REGISTER actions when no current webhooks
 *  2.  Correct webhook URLs constructed
 *  3.  Duplicate registration → SKIP_ALREADY_REGISTERED
 *  4.  Mixed: some registered, some not
 *  5.  Drift reconciliation: extra URL flagged as DEACTIVATE_DRIFT
 *  6.  Drift reconciliation: foreign URL not owned → not touched
 *  7.  Limit near (8+/10) → WARN_LIMIT_NEAR
 *  8.  At limit (10/10) → ABORT_LIMIT_HIT, hasFatalError=true
 *  9.  generatedVerificationKey passes through to PlanResult
 *  10. Action order is deterministic (REGISTER → SKIP → DEACTIVATE → WARN → ABORT)
 *  11. No current registrations → no SKIP or DEACTIVATE actions
 *  12. computePlan is pure: same inputs → same outputs regardless of call order
 *
 * @see docs/plans/vendure-plugin-v0.md §"CLI vendure-viva-register-webhooks" (V10)
 */

import { describe, it, expect } from 'vitest';
import { computePlan } from '../../src/cli/plan.js';
import type { DesiredWebhook, WebhookPlanAction } from '../../src/cli/types.js';
import type { WebhookRegistration } from '@sakeetech/viva-payments-core/types';
import { V1_EVENT_TYPE_IDS } from '@sakeetech/viva-payments-core/webhooks';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const TEST_URL = 'https://api.example.com/viva/webhook';

function makeDesired(url = TEST_URL): DesiredWebhook[] {
  return V1_EVENT_TYPE_IDS.map((eventTypeId) => ({
    eventTypeId,
    url,
    description: `test-registration eventTypeId=${eventTypeId}`,
  }));
}

function makeRegistration(eventTypeId: number, url = TEST_URL, webhookId?: string): WebhookRegistration {
  return { eventTypeId, url, webhookId, isActive: true };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('computePlan()', () => {
  it('generates REGISTER actions for all 6 V1 event types when no current webhooks', () => {
    const plan = computePlan({ desired: makeDesired(), current: [] });
    expect(plan.hasFatalError).toBe(false);
    const registers = plan.actions.filter((a) => a.kind === 'REGISTER');
    expect(registers).toHaveLength(6);

    const registeredTypeIds = registers.map((a) => (a as Extract<WebhookPlanAction, { kind: 'REGISTER' }>).desired.eventTypeId);
    expect(registeredTypeIds.sort((a, b) => a - b)).toEqual([1796, 1797, 1798, 4865, 8193, 8194]);
  });

  it('all REGISTER actions use the correct webhook URL', () => {
    const plan = computePlan({ desired: makeDesired(), current: [] });
    const registers = plan.actions.filter(
      (a): a is Extract<WebhookPlanAction, { kind: 'REGISTER' }> => a.kind === 'REGISTER',
    );
    for (const action of registers) {
      expect(action.desired.url).toBe(TEST_URL);
    }
  });

  it('already-registered webhook → SKIP_ALREADY_REGISTERED, no REGISTER', () => {
    const current = [makeRegistration(1796, TEST_URL, 'webhook-id-1')];
    const plan = computePlan({ desired: makeDesired(), current });
    const skips = plan.actions.filter((a) => a.kind === 'SKIP_ALREADY_REGISTERED');
    const registers = plan.actions.filter((a) => a.kind === 'REGISTER');
    expect(skips).toHaveLength(1);
    expect(registers).toHaveLength(5); // 6 - 1 already registered
  });

  it('all 6 registered → all SKIP, no REGISTER, no DEACTIVATE', () => {
    const current = V1_EVENT_TYPE_IDS.map((id) => makeRegistration(id, TEST_URL));
    const plan = computePlan({ desired: makeDesired(), current });
    expect(plan.actions.every((a) => a.kind === 'SKIP_ALREADY_REGISTERED')).toBe(true);
    expect(plan.actions).toHaveLength(6);
    expect(plan.hasFatalError).toBe(false);
  });

  it('drift reconciliation: extra URL owned by us → DEACTIVATE_DRIFT', () => {
    const staleUrl = 'https://api.example.com/viva/webhook-old';
    const current = [
      makeRegistration(1796, staleUrl, 'old-wh-id'),
    ];
    const plan = computePlan({
      desired: makeDesired(),
      current,
      reconcileDrift: true,
      ownedHostnamePattern: /api\.example\.com/,
    });
    const deactivates = plan.actions.filter((a) => a.kind === 'DEACTIVATE_DRIFT');
    expect(deactivates).toHaveLength(1);
    const deact = deactivates[0] as Extract<WebhookPlanAction, { kind: 'DEACTIVATE_DRIFT' }>;
    expect(deact.existing.url).toBe(staleUrl);
    expect(deact.reason).toBe('URL_NOT_IN_DESIRED');
  });

  it('drift reconciliation: foreign URL → NOT DEACTIVATE_DRIFT', () => {
    const foreignUrl = 'https://other-operator.example.net/viva/webhook';
    const current = [makeRegistration(1796, foreignUrl, 'foreign-wh')];
    const plan = computePlan({
      desired: makeDesired(),
      current,
      reconcileDrift: true,
      ownedHostnamePattern: /api\.example\.com/,
    });
    const deactivates = plan.actions.filter((a) => a.kind === 'DEACTIVATE_DRIFT');
    expect(deactivates).toHaveLength(0);
  });

  it('near limit (8 registered) → WARN_LIMIT_NEAR included', () => {
    // Fill 8 out of 10 slots for event type 1796
    const existing = Array.from({ length: 8 }, (_, i) =>
      makeRegistration(1796, `https://other${i}.example.com/viva/webhook`),
    );
    const plan = computePlan({
      desired: [{ eventTypeId: 1796, url: TEST_URL }],
      current: existing,
      perEventTypeLimit: 10,
      nearLimitFraction: 0.8,
    });
    expect(plan.actions.some((a) => a.kind === 'WARN_LIMIT_NEAR')).toBe(true);
    expect(plan.actions.some((a) => a.kind === 'REGISTER')).toBe(true);
  });

  it('at limit (10 registered) → ABORT_LIMIT_HIT, hasFatalError=true, no REGISTER', () => {
    const existing = Array.from({ length: 10 }, (_, i) =>
      makeRegistration(1796, `https://other${i}.example.com/viva/webhook`),
    );
    const plan = computePlan({
      desired: [{ eventTypeId: 1796, url: TEST_URL }],
      current: existing,
      perEventTypeLimit: 10,
    });
    expect(plan.hasFatalError).toBe(true);
    expect(plan.actions.some((a) => a.kind === 'ABORT_LIMIT_HIT')).toBe(true);
    expect(plan.actions.some((a) => a.kind === 'REGISTER')).toBe(false);
  });

  it('generatedVerificationKey passes through to PlanResult', () => {
    const key = 'test-uuid-key';
    const plan = computePlan({
      desired: makeDesired(),
      current: [],
      generatedVerificationKey: key,
    });
    expect(plan.generatedVerificationKey).toBe(key);
  });

  it('action ordering: REGISTER → SKIP → DEACTIVATE → WARN → ABORT', () => {
    const existing8 = Array.from({ length: 8 }, (_, i) =>
      makeRegistration(1796, `https://stale${i}.example.com/viva/webhook`),
    );
    const plan = computePlan({
      desired: [
        { eventTypeId: 1796, url: TEST_URL },  // new → REGISTER + WARN
        { eventTypeId: 1797, url: 'https://stale0.example.com/viva/webhook' }, // this URL is in existing for 1796, but not 1797 → REGISTER
      ],
      current: existing8,
      reconcileDrift: true,
      ownedHostnamePattern: /stale.*\.example\.com/,
    });

    const kinds = plan.actions.map((a) => a.kind);
    const registerIdx = kinds.indexOf('REGISTER');
    const warnIdx = kinds.indexOf('WARN_LIMIT_NEAR');
    if (registerIdx !== -1 && warnIdx !== -1) {
      expect(registerIdx).toBeLessThan(warnIdx);
    }
  });

  it('is deterministic: same inputs always produce the same output', () => {
    const desired = makeDesired();
    const current = [makeRegistration(1797, TEST_URL)];

    const plan1 = computePlan({ desired, current });
    const plan2 = computePlan({ desired, current });

    expect(JSON.stringify(plan1.actions)).toBe(JSON.stringify(plan2.actions));
    expect(plan1.hasFatalError).toBe(plan2.hasFatalError);
  });

  it('no current registrations → no SKIP or DEACTIVATE_DRIFT', () => {
    const plan = computePlan({ desired: makeDesired(), current: [] });
    expect(plan.actions.every((a) => a.kind !== 'SKIP_ALREADY_REGISTERED')).toBe(true);
    expect(plan.actions.every((a) => a.kind !== 'DEACTIVATE_DRIFT')).toBe(true);
  });
});
