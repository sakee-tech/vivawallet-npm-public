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
import type { DesiredWebhook, PlanResult, WebhookRegistration } from './types.js';
export interface ComputePlanInput {
    desired: readonly DesiredWebhook[];
    current: readonly WebhookRegistration[];
    /** Per Viva: 10 URLs per event type. Default 10. */
    perEventTypeLimit?: number;
    /** Warn fraction. Default 0.8 → warn at 8. */
    nearLimitFraction?: number;
    /** Whether to deactivate URLs not in desired set. Default false. */
    reconcileDrift?: boolean;
    /** Hostname pattern for drift reconciliation (avoid touching foreign webhooks). */
    ownedHostnamePattern?: RegExp;
    /** Verification key generated or sourced from env. */
    generatedVerificationKey?: string | undefined;
}
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
export declare function computePlan(input: ComputePlanInput): PlanResult;
export declare function buildOwnedPattern(webhookUrl: string): RegExp;
//# sourceMappingURL=plan.d.ts.map