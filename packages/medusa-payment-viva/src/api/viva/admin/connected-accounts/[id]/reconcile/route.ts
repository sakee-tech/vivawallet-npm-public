/**
 * route.ts — POST /viva/admin/connected-accounts/:id/reconcile
 *
 * ISV-only admin endpoint. Forces a re-fetch of the connected-account state
 * from Viva and applies the latest verification/acquiring flags onto the
 * local `viva_tenant_merchant` row (when one exists). Used to recover from
 * missed 8194 webhook deliveries.
 *
 *   1. Validates plugin is in ISV mode (404 in merchant mode).
 *   2. Validates admin token (401 if missing/wrong).
 *   3. Fetches current state via `IsvAccounts.retrieveConnectedAccount`.
 *   4. UPDATEs `viva_tenant_merchant.verification_status` when a row matches.
 *   5. Returns `{ accountId, verified, acquiringEnabled, reconciled }`.
 *
 * @see docs/plans/multi-mode-v0.md §6 (mode-surface gating)
 */

import type { MedusaRequest, MedusaResponse } from '@medusajs/framework/http';
import pg from 'pg';
import { IsvHttpClient, IsvAccounts } from '@sakeetech/viva-payments-core/isv';
import { VivaApiError } from '@sakeetech/viva-payments-core/errors';
import type { ConnectedAccountId } from '@sakeetech/viva-payments-core/types';
import { loadConfigFromEnv } from '../../../../../../config.js';
import { buildAuthStrategies } from '../../../../../../resolvers/auth-strategy-factory.js';
import { reject404IfNotIsv } from '../../../_mode-gate.js';
import { reject401IfUnauthorized } from '../../../_admin-auth.js';

export const POST = async (
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

  let pool: pg.Pool | null = null;
  try {
    const config = loadConfigFromEnv(process.env);
    const authStrategies = buildAuthStrategies(config);
    const httpClient = new IsvHttpClient({
      environment: config.environment,
      authStrategy: authStrategies.primary,
    });
    const accounts = new IsvAccounts(httpClient);
    const account = await accounts.retrieveConnectedAccount(id as ConnectedAccountId);

    // Best-effort sync to viva_tenant_merchant. If no row matches (account
    // hasn't been registered locally yet), report reconciled=false.
    const connString =
      process.env['DATABASE_URL'] ??
      `postgresql://${process.env['USER'] ?? 'postgres'}@localhost:5432/postgres`;
    pool = new pg.Pool({ connectionString: connString, max: 1 });

    const verificationStatus = account.verified ? 'verified' : 'unverified';
    const client = await pool.connect();
    let rowCount = 0;
    try {
      const result = await client.query(
        `UPDATE viva_tenant_merchant
            SET verification_status = $1, updated_at = now()
          WHERE connected_account_id = $2`,
        [verificationStatus, id],
      );
      rowCount = result.rowCount ?? 0;
    } finally {
      client.release();
    }

    res.status(200).json({
      accountId: account.accountId,
      verified: account.verified,
      acquiringEnabled: account.acquiringEnabled,
      reconciled: rowCount > 0,
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
      `[viva] POST /viva/admin/connected-accounts/:id/reconcile failed: ${err instanceof Error ? err.message : String(err)}`,
    );
    res.status(500).json({ error: 'internal_error' });
  } finally {
    if (pool) await pool.end().catch(() => undefined);
  }
};
