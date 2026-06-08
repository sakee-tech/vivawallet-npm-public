/**
 * viva-payments-core/webhooks — barrel export.
 *
 * Provides three security layers for the Viva webhook endpoint:
 *   (a) IP allowlist         — isAllowedSourceIp()
 *   (b) Challenge-response   — buildChallengeResponse()
 *   (c) HMAC signature       — verifyHmacSignature() (event 7936 only, per plan A8)
 *
 * Plus runtime helpers for event types and the monotonic status lattice.
 *
 * @see references/viva-docs/md/webhooks-for-payments.txt:254
 */

export { buildChallengeResponse } from './challenge-response.js';

export {
  VIVA_DEMO_IPS,
  VIVA_PROD_IPS,
  isAllowedSourceIp,
} from './ip-allowlist.js';

export {
  extractClientIp,
  type ClientIpRequest,
} from './extract-client-ip.js';

export { verifyHmacSignature } from './hmac-verify.js';

export {
  EVENT_TYPES,
  type VivaEventTypeId,
  isTransactionEvent,
  isOnboardingEvent,
  V1_EVENT_TYPE_IDS,
} from './event-types.js';

export {
  mapStatusLetter,
  validateStatusTransition,
  applyStatusTransition,
  type StatusTransitionResult,
} from './status-lattice.js';
