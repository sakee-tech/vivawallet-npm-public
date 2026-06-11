/**
 * Runtime helpers for Viva webhook event type IDs.
 *
 * Re-exports EVENT_TYPES and VivaEventTypeId from the types package, and
 * provides runtime type-guard helpers for routing webhook payloads.
 *
 * @see references/viva-docs/md/webhooks-for-payments.txt:141
 */

export { EVENT_TYPES, type VivaEventTypeId } from '../types/webhook-events.js';

/**
 * Returns `true` for event types that carry a transaction payload and require
 * MerchantId-based tenant resolution.
 *
 * v1-scope transaction events:
 *   1796 — Transaction Payment Created
 *   1797 — Transaction Reversal Created
 *   1798 — Transaction Failed
 *   4865 — Order Updated (cancellation)
 *
 * @see references/viva-docs/md/webhooks-for-payments.txt:141
 */
export function isTransactionEvent(id: number): id is 1796 | 1797 | 1798 | 4865 {
  return id === 1796 || id === 1797 || id === 1798 || id === 4865;
}

/**
 * Returns `true` for event types that carry an onboarding payload and require
 * ConnectedAccountId-based tenant resolution.
 *
 * v1-scope onboarding events:
 *   8193 — Account Connected
 *   8194 — Account Verification Status Changed
 *
 * @see references/viva-docs/md/webhooks-for-payments.txt:224
 */
export function isOnboardingEvent(id: number): id is 8193 | 8194 {
  return id === 8193 || id === 8194;
}

/**
 * All v1-scope event IDs as a frozen array.
 *
 * Used by `viva:register-webhooks` CLI to enumerate the required registrations
 * and by the route handler to reject unknown event types.
 *
 * @see references/viva-docs/md/webhooks-for-payments.txt:141
 */
export const V1_EVENT_TYPE_IDS: readonly (1796 | 1797 | 1798 | 4865 | 8193 | 8194)[] = Object.freeze([
  1796, 1797, 1798, 4865, 8193, 8194,
] as const);
