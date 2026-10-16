/**
 * route.ts — GET /viva/admin/connected-accounts/:id
 *
 * ISV-only admin endpoint. Returns the current onboarding/verification status
 * of a connected account by id.
 *
 *   1. Validates plugin is in ISV mode (404 in merchant mode).
 *   2. Validates admin token (401 if missing/wrong).
 *   3. Calls `IsvAccounts.retrieveConnectedAccount` against Viva.
 *   4. Returns the response body.
 *
 * @see docs/plans/multi-mode-v0.md §6 (mode-surface gating)
 */

import type { MedusaRequest, MedusaResponse } from '@medusajs/framework/http';
import { IsvHttpClient, IsvAccounts } from '@sakeetech/viva-payments-core/isv';
import { VivaApiError } from '@sakeetech/viva-payments-core/errors';
import type { ConnectedAccountId } from '@sakeetech/viva-payments-core/types';
import { resolveVivaConfig } from '../../../../../container.js';
import { buildAuthStrategies } from '../../../../../resolvers/auth-strategy-factory.js';
import { reject404IfNotIsv } from '../../_mode-gate.js';
import { reject401IfUnauthorized } from '../../_admin-auth.js';

export const GET = async (
  req: MedusaRequest<unknown, { id: string }>,
  res: MedusaResponse,
): Promise<void> => {
  if (reject404IfNotIsv(req, res)) return;
  if (reject401IfUnauthorized(req, res)) return;

  const id = req.params?.id;
  if (!id) {
    res.status(400).json({ error: 'id is required' });
    return;
  }

  try {
    const config = resolveVivaConfig(req.scope);
    if (!config) {
      res.status(503).json({ error: 'plugin_not_configured' });
      return;
    }
    const authStrategies = buildAuthStrategies(config);
    const httpClient = new IsvHttpClient({
      environment: config.environment,
      authStrategy: authStrategies.primary,
    });
    const accounts = new IsvAccounts(httpClient);
    const account = await accounts.retrieveConnectedAccount(id as ConnectedAccountId);
    res.status(200).json(account);
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
      `[viva] GET /viva/admin/connected-accounts/:id failed: ${err instanceof Error ? err.message : String(err)}`,
    );
    res.status(500).json({ error: 'internal_error' });
  }
};
