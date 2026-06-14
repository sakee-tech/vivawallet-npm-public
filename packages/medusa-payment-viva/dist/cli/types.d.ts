/**
 * CLI types for viva-register-webhooks.
 *
 * Defines the DesiredWebhook input shape, the WebhookPlanAction discriminated
 * union, and PlanResult returned by computePlan().
 *
 * @see references/viva-docs/md/webhooks-for-payments.txt:134 (10-URL limit per event type)
 * @see references/viva-docs/md/isv-partner-program.txt:200 (ISV webhook registration)
 */
import type { VivaEventTypeId } from '@sakeetech/viva-payments-core/types';
/**
 * Locally-defined shape preserved for `computePlan`'s historical model.
 *
 * The ISV API exposes no list endpoint, so the CLI never observes existing
 * registrations — `current` is always supplied as `[]`. SKIP_ALREADY_REGISTERED
 * and DEACTIVATE_DRIFT actions therefore cannot fire at runtime; the shape is
 * retained so that snapshot tests over `computePlan` keep passing.
 */
export interface WebhookRegistration {
    webhookId?: string;
    eventTypeId: number;
    url: string;
    isActive: boolean;
}
export type { VivaEventTypeId };
/**
 * A single webhook registration we want to ensure exists at deploy time.
 */
export interface DesiredWebhook {
    eventTypeId: VivaEventTypeId;
    /** Full HTTPS URL that will receive the POST. */
    url: string;
    /** Optional friendly description registered with Viva. */
    description?: string;
}
export type WebhookPlanAction = {
    kind: 'REGISTER';
    desired: DesiredWebhook;
} | {
    kind: 'SKIP_ALREADY_REGISTERED';
    existing: WebhookRegistration;
} | {
    kind: 'DEACTIVATE_DRIFT';
    existing: WebhookRegistration;
    reason: string;
} | {
    kind: 'WARN_LIMIT_NEAR';
    eventTypeId: number;
    current: number;
    limit: number;
} | {
    kind: 'ABORT_LIMIT_HIT';
    eventTypeId: number;
    current: number;
    limit: number;
};
export interface PlanResult {
    actions: WebhookPlanAction[];
    /** True if any ABORT_LIMIT_HIT is in actions. */
    hasFatalError: boolean;
}
//# sourceMappingURL=types.d.ts.map