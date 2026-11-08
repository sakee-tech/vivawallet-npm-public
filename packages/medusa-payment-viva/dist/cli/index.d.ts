/**
 * CLI barrel — re-exports the public surface of the register-webhooks CLI.
 *
 * @see references/viva-docs/md/isv-partner-program.txt:196
 * @see references/viva-docs/md/webhooks-for-payments.txt:134
 */
export { run } from './register-webhooks.js';
export type { RunOptions } from './register-webhooks.js';
export { computePlan } from './plan.js';
export type { ComputePlanInput } from './plan.js';
export type { DesiredWebhook, WebhookPlanAction, PlanResult, } from './types.js';
//# sourceMappingURL=index.d.ts.map