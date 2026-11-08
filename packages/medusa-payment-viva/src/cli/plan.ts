/**
 * plan.ts — pure, IO-free webhook plan computation.
 *
 * Computes the diff between desired webhook state (from config) and current
 * registrations (from Viva API), returning a deterministic action list.
 *
 * Per Viva docs, max 10 webhook URLs per event type.
 *
 * @see references/viva-docs/md/webhooks-for-payments.txt:134 (10-URL limit)
 * @see references/viva-docs/md/isv-partner-program.txt:196 (ISV webhook setup flow)
 */

import type {
  DesiredWebhook,
  WebhookPlanAction,
  PlanResult,
  WebhookRegistration,
} from './types.js';

// ---------------------------------------------------------------------------
// Input
// ---------------------------------------------------------------------------

export interface ComputePlanInput {
  desired: readonly DesiredWebhook[];
  current: readonly WebhookRegistration[];
  /**
   * Per Viva: 10 URLs per event type.
   * @see references/viva-docs/md/webhooks-for-payments.txt:134
   */
  perEventTypeLimit?: number;        // default 10
  /**
   * Warn when registered URLs reach this fraction of the limit.
   * Default 0.8 → warn at 8.
   */
  nearLimitFraction?: number;        // default 0.8
  /**
   * Whether to deactivate URLs that match our hostname pattern but aren't in
   * `desired`. Disabled by default (safer for shared ISV accounts).
   */
  reconcileDrift?: boolean;          // default false
  /**
   * Hostname pattern that identifies "our" registrations for drift reconciliation.
   * Required when reconcileDrift is true to avoid touching foreign webhooks.
   */
  ownedHostnamePattern?: RegExp;
}

// ---------------------------------------------------------------------------
// computePlan
// ---------------------------------------------------------------------------

/**
 * Computes the desired-vs-current diff and returns an ordered action list.
 *
 * Action ordering for human readability:
 *   1. REGISTER (sorted by eventTypeId)
 *   2. SKIP_ALREADY_REGISTERED (sorted by eventTypeId)
 *   3. DEACTIVATE_DRIFT (sorted by eventTypeId)
 *   4. WARN_LIMIT_NEAR (sorted by eventTypeId)
 *   5. ABORT_LIMIT_HIT (sorted by eventTypeId)
 *
 * This is deterministic: same logical inputs always produce the same output
 * regardless of input ordering.
 */
export function computePlan(input: ComputePlanInput): PlanResult {
  const {
    desired,
    current,
    perEventTypeLimit = 10,
    nearLimitFraction = 0.8,
    reconcileDrift = false,
    ownedHostnamePattern,
  } = input;

  const nearLimitThreshold = Math.floor(perEventTypeLimit * nearLimitFraction);

  // -------------------------------------------------------------------------
  // Build a fast-lookup index of current registrations by eventTypeId + url.
  // -------------------------------------------------------------------------
  // Index: eventTypeId → url → WebhookRegistration
  const currentByTypeAndUrl = new Map<number, Map<string, WebhookRegistration>>();
  // Index: eventTypeId → all registrations (for limit counting)
  const currentByType = new Map<number, WebhookRegistration[]>();

  for (const reg of current) {
    if (!currentByType.has(reg.eventTypeId)) {
      currentByType.set(reg.eventTypeId, []);
    }
    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
    currentByType.get(reg.eventTypeId)!.push(reg);

    if (!currentByTypeAndUrl.has(reg.eventTypeId)) {
      currentByTypeAndUrl.set(reg.eventTypeId, new Map());
    }
    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
    currentByTypeAndUrl.get(reg.eventTypeId)!.set(reg.url, reg);
  }

  // -------------------------------------------------------------------------
  // Accumulators (by bucket for deterministic ordering).
  // -------------------------------------------------------------------------
  const registerActions: WebhookPlanAction[] = [];
  const skipActions: WebhookPlanAction[] = [];
  const warnActions: WebhookPlanAction[] = [];
  const abortActions: WebhookPlanAction[] = [];

  // Work on a sorted copy of desired for deterministic output.
  const sortedDesired = [...desired].sort((a, b) => a.eventTypeId - b.eventTypeId);

  for (const d of sortedDesired) {
    const urlIndex = currentByTypeAndUrl.get(d.eventTypeId);
    const existingForType = currentByType.get(d.eventTypeId) ?? [];
    const registeredCount = existingForType.length;

    // Already registered with exact URL → skip.
    if (urlIndex?.has(d.url)) {
      // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
      skipActions.push({ kind: 'SKIP_ALREADY_REGISTERED', existing: urlIndex.get(d.url)! });
      continue;
    }

    // At limit → abort, no registration attempted.
    if (registeredCount >= perEventTypeLimit) {
      abortActions.push({
        kind: 'ABORT_LIMIT_HIT',
        eventTypeId: d.eventTypeId,
        current: registeredCount,
        limit: perEventTypeLimit,
      });
      continue;
    }

    // Near limit → warn AND register (still proceeds).
    if (registeredCount >= nearLimitThreshold) {
      warnActions.push({
        kind: 'WARN_LIMIT_NEAR',
        eventTypeId: d.eventTypeId,
        current: registeredCount,
        limit: perEventTypeLimit,
      });
    }

    registerActions.push({ kind: 'REGISTER', desired: d });
  }

  // -------------------------------------------------------------------------
  // Drift reconciliation.
  // -------------------------------------------------------------------------
  const deactivateActions: WebhookPlanAction[] = [];

  if (reconcileDrift) {
    // Build set of desired URLs for fast membership test.
    const desiredUrlSet = new Set(desired.map((d) => d.url));

    const sortedCurrent = [...current].sort((a, b) => a.eventTypeId - b.eventTypeId);

    for (const reg of sortedCurrent) {
      // Only deactivate if:
      // 1. URL is not in desired set.
      // 2. URL matches our owned hostname pattern (don't touch foreign webhooks).
      const isOwned = ownedHostnamePattern ? ownedHostnamePattern.test(reg.url) : true;
      if (!desiredUrlSet.has(reg.url) && isOwned) {
        deactivateActions.push({
          kind: 'DEACTIVATE_DRIFT',
          existing: reg,
          reason: 'URL_NOT_IN_DESIRED',
        });
      }
    }
  }

  // -------------------------------------------------------------------------
  // Compose final ordered list.
  // -------------------------------------------------------------------------
  const actions: WebhookPlanAction[] = [
    ...registerActions,
    ...skipActions,
    ...deactivateActions,
    ...warnActions,
    ...abortActions,
  ];

  const hasFatalError = abortActions.length > 0;

  return { actions, hasFatalError };
}
