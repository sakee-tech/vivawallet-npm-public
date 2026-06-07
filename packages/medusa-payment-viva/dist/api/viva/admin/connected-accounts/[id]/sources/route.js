/**
 * route.ts — POST /viva/admin/connected-accounts/:id/sources
 *
 * ISV-only admin endpoint. Creates a payment source (ecommerce or physical)
 * on a connected merchant's Viva account via `POST /api/sources` on the
 * legacy host, authenticated with **Reseller Basic** auth.
 *
 *   1. Validates plugin is in ISV mode (404 in merchant mode).
 *   2. Validates admin token (401 if missing/wrong).
 *   3. Requires `config.reseller` (412 with `VIVA_RESELLER_CREDENTIALS_MISSING`).
 *   4. Resolves the connected merchant's `merchantId` UUID via
 *      `IsvAccounts.retrieveConnectedAccount(:id)` — 409 with
 *      `VIVA_ACCOUNT_NOT_VERIFIED` when `verified !== true` or `merchantId`
 *      is null.
 *   5. Builds a per-request `BasicAuthClient` with `authVariant: 'reseller'`
 *      whose username slot carries `resellerId:account.merchantId` (NOT the
 *      platform's merchant id — see AUTH.md §1.2 line 98 + ENDPOINTS.md §5.1).
 *   6. Calls `IsvSources.createEcommerceSource` or `createPhysicalSource`
 *      based on the body's `kind` discriminator.
 *   7. Returns 201 + `{ sourceCode, name, kind }`.
 *
 * Viva 4xx on `/api/sources` is mapped to 422 with `VIVA_SOURCE_CREATION_FAILED`.
 * Viva 5xx / non-API errors fall through to the existing 5xx envelope.
 *
 * @see docs/plans/multi-mode-v0.md §6 (admin REST table)
 * @see docs/ENDPOINTS.md §5.1
 * @see docs/AUTH.md §1.2 (Reseller Basic)
 * @see docs/ERRORS.md (VIVA_SOURCE_CREATION_FAILED, VIVA_RESELLER_CREDENTIALS_MISSING)
 */
import { IsvHttpClient, IsvAccounts, IsvSources, } from '@sakeetech/viva-payments-core/isv';
import { BasicAuthClient } from '@sakeetech/viva-payments-core/legacy';
import { VivaApiError, VivaValidationError, } from '@sakeetech/viva-payments-core/errors';
import { loadConfigFromEnv } from '../../../../../../config.js';
import { buildAuthStrategies } from '../../../../../../resolvers/auth-strategy-factory.js';
import { reject404IfNotIsv } from '../../../_mode-gate.js';
import { reject401IfUnauthorized } from '../../../_admin-auth.js';
/**
 * Narrow the raw body into an IsvSources input by `kind`. Returns either a
 * validated `{ kind, input }` pair or a `{ error }` envelope describing the
 * first validation failure.
 */
function parseBody(raw) {
    const body = (raw ?? {});
    const kind = body.kind;
    if (kind !== 'ecommerce' && kind !== 'physical') {
        return {
            ok: false,
            status: 400,
            body: {
                error: 'invalid_request',
                message: "body.kind must be 'ecommerce' or 'physical'",
            },
        };
    }
    const sourceCode = body.sourceCode;
    if (sourceCode !== undefined && typeof sourceCode !== 'number') {
        return {
            ok: false,
            status: 400,
            body: { error: 'invalid_request', message: 'sourceCode must be a number' },
        };
    }
    if (kind === 'physical') {
        if (typeof body.name !== 'string' || body.name.trim() === '') {
            return {
                ok: false,
                status: 400,
                body: { error: 'invalid_request', message: 'name is required for physical sources' },
            };
        }
        const input = {
            name: body.name,
            ...(sourceCode !== undefined ? { sourceCode: sourceCode } : {}),
        };
        return { ok: true, kind, input };
    }
    // ecommerce
    if (typeof body.domain !== 'string' || body.domain.trim() === '') {
        return {
            ok: false,
            status: 400,
            body: { error: 'invalid_request', message: 'domain is required for ecommerce sources' },
        };
    }
    if (typeof body.pathSuccess !== 'string' || body.pathSuccess.trim() === '') {
        return {
            ok: false,
            status: 400,
            body: { error: 'invalid_request', message: 'pathSuccess is required for ecommerce sources' },
        };
    }
    if (typeof body.pathFail !== 'string' || body.pathFail.trim() === '') {
        return {
            ok: false,
            status: 400,
            body: { error: 'invalid_request', message: 'pathFail is required for ecommerce sources' },
        };
    }
    const ecomInput = {
        domain: body.domain,
        pathSuccess: body.pathSuccess,
        pathFail: body.pathFail,
        ...(typeof body.name === 'string' ? { name: body.name } : {}),
        ...(typeof body.isSecure === 'boolean' ? { isSecure: body.isSecure } : {}),
        ...(sourceCode !== undefined ? { sourceCode: sourceCode } : {}),
    };
    return { ok: true, kind, input: ecomInput };
}
// ---------------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------------
export const POST = async (req, res) => {
    if (reject404IfNotIsv(req, res))
        return;
    if (reject401IfUnauthorized(req, res))
        return;
    const id = req.params?.id;
    if (!id) {
        res.status(400).json({ error: 'id is required' });
        return;
    }
    // Load config + check reseller block before parsing body so misconfigured
    // deployments fail fast with a clear envelope.
    let config;
    try {
        config = loadConfigFromEnv(process.env);
    }
    catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        res.status(500).json({ error: 'internal_error', message });
        return;
    }
    if (config.mode !== 'isv') {
        // Defensive: reject404IfNotIsv already covered this, but the type guard
        // narrows config to VivaIsvConfig below.
        res.status(404).json({ error: 'Not Found' });
        return;
    }
    if (!config.reseller) {
        res.status(412).json({
            error: 'precondition_failed',
            code: 'VIVA_RESELLER_CREDENTIALS_MISSING',
            message: 'POST /viva/admin/connected-accounts/:id/sources requires reseller credentials. ' +
                'Set VIVA_RESELLER_ID, VIVA_RESELLER_MERCHANT_ID, VIVA_RESELLER_API_KEY.',
        });
        return;
    }
    const parsed = parseBody(req.body);
    if (!parsed.ok) {
        res.status(parsed.status).json(parsed.body);
        return;
    }
    try {
        // 1. Resolve the connected merchant's UUID via OAuth2 (platform) creds.
        const authStrategies = buildAuthStrategies(config);
        const httpClient = new IsvHttpClient({
            environment: config.environment,
            authStrategy: authStrategies.primary,
        });
        const accounts = new IsvAccounts(httpClient);
        const account = await accounts.retrieveConnectedAccount(id);
        if (account.verified !== true || account.merchantId == null) {
            res.status(409).json({
                error: 'conflict',
                code: 'VIVA_ACCOUNT_NOT_VERIFIED',
                message: `Connected account ${id} is not verified yet (verified=${String(account.verified)}, ` +
                    `merchantId=${account.merchantId == null ? 'null' : 'set'}). ` +
                    `Wait for webhook 8194 or POST /viva/admin/connected-accounts/${id}/reconcile.`,
            });
            return;
        }
        // 2. Build Reseller Basic client scoped to THIS connected merchant.
        //    Per AUTH.md §1.2 line 98 + ENDPOINTS.md §5.1: the MerchantId slot of
        //    Reseller Basic is the connected merchant's UUID (account.merchantId),
        //    NOT the platform's merchant id (config.reseller.merchantId — which
        //    is unused here, despite the field name).
        const basic = new BasicAuthClient({
            authVariant: 'reseller',
            environment: config.environment,
            resellerId: config.reseller.resellerId,
            merchantId: account.merchantId,
            resellerApiKey: config.reseller.resellerApiKey,
        });
        const sources = new IsvSources(basic);
        // 3. Dispatch on kind.
        const response = parsed.kind === 'ecommerce'
            ? await sources.createEcommerceSource(parsed.input)
            : await sources.createPhysicalSource(parsed.input);
        res.status(201).json({
            sourceCode: response.sourceCode,
            name: response.name ?? parsed.input.name,
            kind: parsed.kind,
        });
    }
    catch (err) {
        if (err instanceof VivaValidationError) {
            res.status(400).json({
                error: 'invalid_request',
                code: err.code,
                message: err.message,
            });
            return;
        }
        if (err instanceof VivaApiError) {
            const status = err.httpStatus;
            // Map Viva 4xx on /api/sources to VIVA_SOURCE_CREATION_FAILED (422 envelope).
            if (typeof status === 'number' && status >= 400 && status < 500) {
                res.status(422).json({
                    error: 'unprocessable_entity',
                    code: 'VIVA_SOURCE_CREATION_FAILED',
                    vivaStatus: status,
                    vivaCode: err.code,
                    message: err.message,
                });
                return;
            }
            // Non-4xx Viva error (network, 5xx) — pass through.
            res.status(status ?? 502).json({
                error: 'viva_api_error',
                code: err.code,
                message: err.message,
            });
            return;
        }
        const logger = req.scope?.resolve?.('logger');
        logger?.error?.(`[viva] POST /viva/admin/connected-accounts/:id/sources failed: ${err instanceof Error ? err.message : String(err)}`);
        res.status(500).json({ error: 'internal_error' });
    }
};
//# sourceMappingURL=route.js.map