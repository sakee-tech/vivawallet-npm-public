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
import type { DesiredWebhook, PlanResult, WebhookRegistration } from './types.js';
export interface ComputePlanInput {
    desired: readonly DesiredWebhook[];
    current: readonly WebhookRegistration[];
    /**
     * Per Viva: 10 URLs per event type.
     * @see references/viva-docs/md/webhooks-for-payments.txt:134
     */
    perEventTypeLimit?: number;
    /**
     * Warn when registered URLs reach this fraction of the limit.
     * Default 0.8 → warn at 8.
     */
    nearLimitFraction?: number;
    /**
     * Whether to deactivate URLs that match our hostname pattern but aren't in
     * `desired`. Disabled by default (safer for shared ISV accounts).
     */
    reconcileDrift?: boolean;
    /**
     * Hostname pattern that identifies "our" registrations for drift reconciliation.
     * Required when reconcileDrift is true to avoid touching foreign webhooks.
     */
    ownedHostnamePattern?: RegExp;
}
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
export declare function computePlan(input: ComputePlanInput): PlanResult;
//# sourceMappingURL=plan.d.ts.map