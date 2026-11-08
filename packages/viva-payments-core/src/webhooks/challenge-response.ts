/**
 * Viva Wallet webhook challenge-response handler.
 *
 * When Viva verifies a webhook URL at registration time it sends a GET request.
 * The endpoint must respond with `{"Key": "<webhook_verification_key>"}`.
 *
 * @see references/viva-docs/md/webhooks-for-payments.txt:311
 */

import { VivaWebhookError } from '../errors/index.js';

/**
 * Returns the GET-request response body for Viva's URL verification challenge.
 *
 * @param webhookVerificationKey  The webhook verification key obtained from
 *   Viva's `GET /api/messages/config/token` endpoint. Must be non-empty.
 *
 * @throws VivaWebhookError when the key is empty or whitespace-only.
 *
 * @see references/viva-docs/md/webhooks-for-payments.txt:362
 *
 * @example
 * // Route handler (framework-agnostic pseudocode):
 * if (req.method === 'GET') {
 *   return res.json(buildChallengeResponse(env.VIVA_WEBHOOK_KEY));
 * }
 */
export function buildChallengeResponse(webhookVerificationKey: string): { Key: string } {
  if (!webhookVerificationKey || webhookVerificationKey.trim().length === 0) {
    throw new VivaWebhookError({
      message:
        'webhookVerificationKey must be a non-empty string. ' +
        'Obtain it from GET /api/messages/config/token and set VIVA_WEBHOOK_KEY.',
    });
  }

  return { Key: webhookVerificationKey };
}
