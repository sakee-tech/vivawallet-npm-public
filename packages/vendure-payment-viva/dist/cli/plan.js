/**
 * cli/plan.ts — Pure, IO-free webhook plan computation.
 *
 * Computes the diff between desired webhook state (from config) and current
 * registrations (from Viva API), returning a deterministic action list.
 *
 * Per Viva docs, max 10 webhook URLs per event type.
 *
 * Mirrors medusa-payment-viva/src/cli/plan.ts conventions exactly.
 *
 * @see packages/medusa-payment-viva/src/cli/plan.ts
 * @see references/viva-docs/md/webhooks-for-payments.txt:134 (10-URL limit)
 */
// ---------------------------------------------------------------------------
// computePlan
// ---------------------------------------------------------------------------
/**
 * Deterministic diff between desired and current webhook registrations.
 *
 * Action ordering:
 *   1. REGISTER (sorted by eventTypeId)
 *   2. SKIP_ALREADY_REGISTERED (sorted by eventTypeId)
 *   3. DEACTIVATE_DRIFT (sorted by eventTypeId)
 *   4. WARN_LIMIT_NEAR (sorted by eventTypeId)
 *   5. ABORT_LIMIT_HIT (sorted by eventTypeId)
 */
export function computePlan(input) {
    const { desired, current, perEventTypeLimit = 10, nearLimitFraction = 0.8, reconcileDrift = false, ownedHostnamePattern, generatedVerificationKey, } = input;
    const nearLimitThreshold = Math.floor(perEventTypeLimit * nearLimitFraction);
    // Index: eventTypeId → url → WebhookRegistration
    const currentByTypeAndUrl = new Map();
    // Index: eventTypeId → all registrations (for limit counting)
    const currentByType = new Map();
    for (const reg of current) {
        if (!currentByType.has(reg.eventTypeId)) {
            currentByType.set(reg.eventTypeId, []);
        }
        currentByType.get(reg.eventTypeId).push(reg);
        if (!currentByTypeAndUrl.has(reg.eventTypeId)) {
            currentByTypeAndUrl.set(reg.eventTypeId, new Map());
        }
        currentByTypeAndUrl.get(reg.eventTypeId).set(reg.url, reg);
    }
    const registerActions = [];
    const skipActions = [];
    const warnActions = [];
    const abortActions = [];
    const sortedDesired = [...desired].sort((a, b) => a.eventTypeId - b.eventTypeId);
    for (const d of sortedDesired) {
        const urlIndex = currentByTypeAndUrl.get(d.eventTypeId);
        const existingForType = currentByType.get(d.eventTypeId) ?? [];
        const registeredCount = existingForType.length;
        if (urlIndex?.has(d.url)) {
            skipActions.push({ kind: 'SKIP_ALREADY_REGISTERED', existing: urlIndex.get(d.url) });
            continue;
        }
        if (registeredCount >= perEventTypeLimit) {
            abortActions.push({
                kind: 'ABORT_LIMIT_HIT',
                eventTypeId: d.eventTypeId,
                current: registeredCount,
                limit: perEventTypeLimit,
            });
            continue;
        }
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
    // Drift reconciliation
    const deactivateActions = [];
    if (reconcileDrift) {
        const desiredUrlSet = new Set(desired.map((d) => d.url));
        const sortedCurrent = [...current].sort((a, b) => a.eventTypeId - b.eventTypeId);
        for (const reg of sortedCurrent) {
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
    const actions = [
        ...registerActions,
        ...skipActions,
        ...deactivateActions,
        ...warnActions,
        ...abortActions,
    ];
    const hasFatalError = abortActions.length > 0;
    return { actions, hasFatalError, generatedVerificationKey };
}
// ---------------------------------------------------------------------------
// buildOwnedPattern helper (shared with register-webhooks)
// ---------------------------------------------------------------------------
export function buildOwnedPattern(webhookUrl) {
    try {
        const { hostname } = new URL(webhookUrl);
        const escaped = hostname.replace(/\./g, '\\.');
        return new RegExp(escaped);
    }
    catch {
        return /.*/;
    }
}
//# sourceMappingURL=plan.js.map