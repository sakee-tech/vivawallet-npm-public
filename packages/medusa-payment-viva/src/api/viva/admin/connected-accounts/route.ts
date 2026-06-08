/**
 * route.ts — POST /viva/admin/connected-accounts
 *
 * ISV-only admin endpoint. Initiates a Viva connected-account onboarding flow:
 *   1. Validates that the plugin is in ISV mode (404 in merchant mode).
 *   2. Validates admin token (401 if missing/wrong).
 *   3. Calls `IsvAccounts.createConnectedAccount` against Viva.
 *   4. Returns `{ accountId, onboardingUrl }`.
 *
 * Merchant-mode gating uses Option 2 (per-handler 404 short-circuit) — see
 * `_mode-gate.ts` for the rationale. Medusa v2 has no clean way to skip a
 * `route.ts` file at boot based on plugin config.
 *
 * @see docs/plans/multi-mode-v0.md §6 (mode-surface gating)
 * @see references/viva-docs/md/payment-isv-api.txt:1 (Connected Accounts API)
 */

import type { MedusaRequest, MedusaResponse } from '@medusajs/framework/http';
import { IsvHttpClient } from '@sakeetech/viva-payments-core/isv';
import { IsvAccounts } from '@sakeetech/viva-payments-core/isv';
import { VivaApiError } from '@sakeetech/viva-payments-core/errors';
import { loadConfigFromEnv } from '../../../../config.js';
import { buildAuthStrategies } from '../../../../resolvers/auth-strategy-factory.js';
import { reject404IfNotIsv } from '../_mode-gate.js';
import { reject401IfUnauthorized } from '../_admin-auth.js';

interface CreateRequestBody {
  email?: string;
  returnUrl?: string;
  branding?: {
    partnerName: string;
    logoUrl: string;
    primaryColor?: string;
  };
}

export const POST = async (
  req: MedusaRequest,
  res: MedusaResponse,
): Promise<void> => {
  // 1. Mode gate first — merchant mode pretends route doesn't exist.
  if (reject404IfNotIsv(req, res)) return;

  // 2. Admin token gate.
  if (reject401IfUnauthorized(req, res)) return;

  // 3. Body validation.
  const body = (req.body ?? {}) as CreateRequestBody;
  if (!body.email || typeof body.email !== 'string') {
    res.status(400).json({ error: 'email is required' });
    return;
  }
  if (!body.returnUrl || typeof body.returnUrl !== 'string') {
    res.status(400).json({ error: 'returnUrl is required' });
    return;
  }

  // 4. Build client + call Viva.
  try {
    const config = loadConfigFromEnv(process.env);
    const authStrategies = buildAuthStrategies(config);
    const httpClient = new IsvHttpClient({
      environment: config.environment,
      authStrategy: authStrategies.primary,
    });
    const accounts = new IsvAccounts(httpClient);
    const created = await accounts.createConnectedAccount({
      email: body.email,
      returnUrl: body.returnUrl,
      ...(body.branding ? { branding: body.branding } : {}),
    });

    res.status(200).json({
      accountId: created.accountId,
      onboardingUrl: created.invitation.redirectUrl,
    });
  } catch (err) {
    if (err instanceof VivaApiError) {
      res.status(err.httpStatus ?? 502).json({
        error: 'viva_api_error',
        code: err.code,
        message: err.message,
      });
      return;
    }
    const logger = req.scope?.resolve?.('logger') as
      | { error?: (m: string) => void }
      | undefined;
    logger?.error?.(
      `[viva] POST /viva/admin/connected-accounts failed: ${err instanceof Error ? err.message : String(err)}`,
    );
    res.status(500).json({ error: 'internal_error' });
  }
};
