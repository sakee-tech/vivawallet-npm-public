/**
 * api/admin-sources.controller.ts — ISV-only admin REST for /api/sources wrapping.
 *
 * Single route:
 *
 *   POST /viva/admin/connected-accounts/:id/sources
 *     Creates a payment source (ecommerce or physical) on a connected
 *     merchant's Viva account via POST /api/sources on the legacy host,
 *     authenticated with Reseller Basic auth (per AUTH.md §1.2).
 *
 * Flow:
 *   1. Mode gate: 404 in merchant mode (mirrors Medusa _mode-gate.ts).
 *   2. Reseller gate: 412 VIVA_RESELLER_CREDENTIALS_MISSING when
 *      options.reseller is absent.
 *   3. Body parse: 400 on missing/invalid fields or unknown kind.
 *   4. Account lookup: IsvAccounts.retrieveConnectedAccount(:id).
 *      → 409 VIVA_ACCOUNT_NOT_VERIFIED when verified !== true or
 *        merchantId is null.
 *   5. BasicAuthClient {authVariant:'reseller'} built with the connected
 *      merchant's UUID (account.merchantId — NOT config.reseller.merchantId).
 *   6. IsvSources.createEcommerceSource / createPhysicalSource.
 *   7. For ecommerce sources: persist `vivaSourceCode` (String-coerced) to the
 *      channel resolved by vivaAccountId and assign the `viva` PaymentMethod.
 *      Best-effort — a persistence failure is logged but does not fail the call.
 *   8. 201 with {sourceCode, name, kind}.
 *
 * Viva 4xx on /api/sources → 422 VIVA_SOURCE_CREATION_FAILED.
 * Viva 5xx / auth errors → 503 VIVA_AUTH_DOWN (existing envelope rule).
 *
 * @see docs/plans/multi-mode-v0.md §6 (admin REST table)
 * @see docs/AUTH.md §1.2 (Reseller Basic)
 * @see docs/ENDPOINTS.md §5.1
 * @see packages/medusa-payment-viva/src/api/viva/admin/connected-accounts/[id]/sources/route.ts
 */

import {
  Controller,
  Post,
  Param,
  Body,
  Res,
  Inject,
  UseGuards,
} from '@nestjs/common';
import type { ServerResponse } from 'node:http';
import { Allow, Permission, Logger, AuthGuard, RequestContextService } from '@vendure/core';
import {
  IsvAccounts,
  IsvHttpClient,
  IsvSources,
} from '@sakeetech/viva-payments-core/isv';
import { BasicAuthClient } from '@sakeetech/viva-payments-core/legacy';
import {
  VivaApiError,
  VivaAuthError,
  VivaValidationError,
} from '@sakeetech/viva-payments-core/errors';
import type { ConnectedAccountId } from '@sakeetech/viva-payments-core/types';
import type {
  VivaPaymentPluginOptions,
  VivaIsvOptions,
} from '../types.js';
import type { VivaOAuth2Strategy } from '../providers/viva-oauth2-strategy.provider.js';
import { ConnectedAccountsService } from '../services/connected-accounts.service.js';
import { VivaPluginError } from '../util/error-envelope.js';
import {
  VIVA_PLUGIN_OPTIONS,
  VIVA_OAUTH2_STRATEGY_TOKEN,
  VIVA_LOG_CONTEXT,
} from '../constants.js';

// ---------------------------------------------------------------------------
// Request body
// ---------------------------------------------------------------------------

interface BaseSourceBody {
  kind?: unknown;
  name?: unknown;
  sourceCode?: unknown;
}

interface EcommerceSourceBody extends BaseSourceBody {
  domain?: unknown;
  pathSuccess?: unknown;
  pathFail?: unknown;
  isSecure?: unknown;
}

interface ParsedEcommerce {
  ok: true;
  kind: 'ecommerce';
  input: Parameters<IsvSources['createEcommerceSource']>[0];
}
interface ParsedPhysical {
  ok: true;
  kind: 'physical';
  input: Parameters<IsvSources['createPhysicalSource']>[0];
}
interface ParseFailure {
  ok: false;
  status: number;
  message: string;
}

function parseBody(raw: unknown): ParsedEcommerce | ParsedPhysical | ParseFailure {
  const body = (raw ?? {}) as EcommerceSourceBody;
  const kind = body.kind;

  if (kind !== 'ecommerce' && kind !== 'physical') {
    return {
      ok: false,
      status: 400,
      message: "body.kind must be 'ecommerce' or 'physical'",
    };
  }

  // sourceCode is required — Viva returns no body from POST /api/sources so
  // the code cannot be recovered after the call (defect #24 root cause). Viva
  // types it as a string (payment-isv-api.yaml:7298-7301; support-confirmed
  // 2026-06-13). Accept a number or string from the HTTP client and normalize
  // to a quoted 4-digit string for the wire.
  const rawSourceCode = body.sourceCode;
  const sourceCode =
    typeof rawSourceCode === 'number' && Number.isInteger(rawSourceCode)
      ? String(rawSourceCode)
      : rawSourceCode;
  if (typeof sourceCode !== 'string' || !/^[1-9]\d{3}$/.test(sourceCode)) {
    return {
      ok: false,
      status: 400,
      message: 'sourceCode is required and must be a 4-digit code (1000–9999)',
    };
  }

  if (kind === 'physical') {
    if (typeof body.name !== 'string' || body.name.trim() === '') {
      return {
        ok: false,
        status: 400,
        message: 'name is required for physical sources',
      };
    }
    const input: Parameters<IsvSources['createPhysicalSource']>[0] = {
      name: body.name,
      sourceCode,
    };
    return { ok: true, kind, input };
  }

  if (typeof body.domain !== 'string' || body.domain.trim() === '') {
    return { ok: false, status: 400, message: 'domain is required for ecommerce sources' };
  }
  if (typeof body.pathSuccess !== 'string' || body.pathSuccess.trim() === '') {
    return { ok: false, status: 400, message: 'pathSuccess is required for ecommerce sources' };
  }
  if (typeof body.pathFail !== 'string' || body.pathFail.trim() === '') {
    return { ok: false, status: 400, message: 'pathFail is required for ecommerce sources' };
  }
  // Viva marks `name` required on the new_source schema (payment-isv-api.yaml:7266).
  if (typeof body.name !== 'string' || body.name.trim() === '') {
    return { ok: false, status: 400, message: 'name is required for ecommerce sources' };
  }

  const ecomInput: Parameters<IsvSources['createEcommerceSource']>[0] = {
    domain: body.domain,
    pathSuccess: body.pathSuccess,
    pathFail: body.pathFail,
    name: body.name,
    sourceCode,
    ...(typeof body.isSecure === 'boolean' ? { isSecure: body.isSecure } : {}),
  };
  return { ok: true, kind, input: ecomInput };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function writeError(res: ServerResponse, status: number, err: VivaPluginError): void {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(err.toJSON()));
}

// ---------------------------------------------------------------------------
// Controller
// ---------------------------------------------------------------------------

@Controller('viva/admin/connected-accounts')
@UseGuards(AuthGuard)
export class AdminSourcesController {
  constructor(
    @Inject(VIVA_PLUGIN_OPTIONS)
    private readonly options: VivaPaymentPluginOptions,
    @Inject(VIVA_OAUTH2_STRATEGY_TOKEN)
    private readonly oauth2: VivaOAuth2Strategy,
    private readonly connectedAccounts: ConnectedAccountsService,
    private readonly requestContextService: RequestContextService,
  ) {}

  /**
   * Narrow options to ISV mode + reseller block.
   * Returns:
   *   - { ok: true, isv } on success.
   *   - { ok: false, status, err } on mode mismatch (404) or missing reseller (412).
   */
  private requireIsvWithReseller():
    | { ok: true; isv: VivaIsvOptions & { reseller: NonNullable<VivaIsvOptions['reseller']> } }
    | { ok: false; status: number; err: VivaPluginError } {
    if (this.options.mode !== 'isv') {
      return {
        ok: false,
        status: 404,
        err: VivaPluginError.channelMisconfigured(
          'POST /viva/admin/connected-accounts/:id/sources is ISV-only — not available in merchant mode.',
        ),
      };
    }
    if (!this.options.reseller) {
      return {
        ok: false,
        status: 412,
        err: VivaPluginError.resellerCredentialsMissing(),
      };
    }
    return {
      ok: true,
      isv: this.options as VivaIsvOptions & {
        reseller: NonNullable<VivaIsvOptions['reseller']>;
      },
    };
  }

  /** Build the OAuth2-backed IsvAccounts client (platform creds). */
  private buildIsvAccounts(): IsvAccounts {
    const client = new IsvHttpClient({
      environment: this.options.environment,
      authStrategy: this.oauth2,
    });
    return new IsvAccounts(client);
  }

  // -------------------------------------------------------------------------
  // POST /viva/admin/connected-accounts/:id/sources
  // -------------------------------------------------------------------------

  @Post(':id/sources')
  @Allow(Permission.SuperAdmin)
  async createSource(
    @Param('id') id: string,
    @Body() body: unknown,
    @Res() res: ServerResponse,
  ): Promise<void> {
    if (!id) {
      writeError(res, 400, VivaPluginError.channelMisconfigured('id is required'));
      return;
    }

    // 1. Mode + reseller gate
    const gate = this.requireIsvWithReseller();
    if (!gate.ok) {
      writeError(res, gate.status, gate.err);
      return;
    }
    const { isv } = gate;

    // 2. Parse body
    const parsed = parseBody(body);
    if (!parsed.ok) {
      writeError(res, parsed.status, VivaPluginError.channelMisconfigured(parsed.message));
      return;
    }

    // 3. Resolve connected account
    let account: Awaited<ReturnType<IsvAccounts['retrieveConnectedAccount']>>;
    try {
      const accounts = this.buildIsvAccounts();
      account = await accounts.retrieveConnectedAccount(id as ConnectedAccountId);
    } catch (err) {
      if (err instanceof VivaAuthError || (err instanceof VivaApiError && (err.httpStatus ?? 0) >= 500)) {
        writeError(
          res,
          503,
          VivaPluginError.authDown(
            err instanceof Error ? err.message : 'Viva service unavailable',
            err,
          ),
        );
        return;
      }
      if (err instanceof VivaApiError) {
        const status = err.httpStatus ?? 502;
        writeError(
          res,
          status >= 400 && status < 600 ? status : 502,
          VivaPluginError.apiError({
            message: err.message,
            vivaErrorMessage: err.message,
            cause: err,
          }),
        );
        return;
      }
      Logger.error(
        `[AdminSources] retrieveConnectedAccount failed for id=${id}: ${String(err)}`,
        VIVA_LOG_CONTEXT,
      );
      writeError(res, 500, VivaPluginError.internalError('Unexpected error', err));
      return;
    }

    if (account.verified !== true || account.merchantId == null) {
      const err = VivaPluginError.accountNotVerified(
        `Connected account ${id} is not verified yet (verified=${String(account.verified)}, ` +
          `merchantId=${account.merchantId == null ? 'null' : 'set'}). ` +
          `Wait for webhook 8194 or POST /viva/admin/connected-accounts/${id}/reconcile.`,
      );
      writeError(res, 409, err);
      return;
    }

    // 4. Build Reseller Basic client scoped to THIS connected merchant.
    //    Per AUTH.md §1.2: the MerchantId slot of Reseller Basic is the
    //    connected merchant's UUID (account.merchantId), NOT the platform's
    //    merchant id (isv.reseller.merchantId — unused here despite the name).
    const basic = new BasicAuthClient({
      authVariant: 'reseller',
      environment: isv.environment,
      resellerId: isv.reseller.resellerId,
      merchantId: account.merchantId,
      resellerApiKey: isv.reseller.resellerApiKey,
    });
    const sources = new IsvSources(basic);

    // 5. Dispatch on kind.
    //    IsvSources.createEcommerceSource / createPhysicalSource return void —
    //    Viva's POST /api/sources gives HTTP 200 with no body
    //    (payment-isv-api.yaml:279-284). The sourceCode is caller-supplied via
    //    parsed.input.sourceCode; we NEVER read it from the response (defect #24).
    try {
      await (parsed.kind === 'ecommerce'
        ? sources.createEcommerceSource(parsed.input)
        : sources.createPhysicalSource(parsed.input));

      // Close the onboarding loop for ecommerce sources: persist the source
      // code as the channel's Smart-Checkout source and assign the Viva
      // PaymentMethod so the storefront can offer it. Physical (POS) sources
      // are not the web checkout source, so they are not persisted here.
      //
      // Use parsed.input.sourceCode — the code the caller supplied to Viva
      // (never response.sourceCode which would be undefined since API returns
      // no body; that undefined propagation was the root of defect #24).
      //
      // The source already exists at Viva at this point — a persistence failure
      // must NOT fail the request, so it is logged and the 201 is still
      // returned (recover via re-create or a manual channel edit).
      if (parsed.kind === 'ecommerce') {
        const sourceCode = parsed.input.sourceCode;
        try {
          const channel = await this.connectedAccounts.findChannelByAccountId(id);
          if (channel) {
            const ctx = await this.requestContextService.create({
              apiType: 'admin',
              channelOrToken: channel,
            });
            await this.connectedAccounts.writeSourceCode(ctx, channel, sourceCode);
            await this.connectedAccounts.assignVivaPaymentMethod(ctx, channel);
          } else {
            Logger.warn(
              `[AdminSources] No channel with vivaAccountId=${id} — sourceCode=${String(
                sourceCode,
              )} created at Viva but not persisted to a channel.`,
              VIVA_LOG_CONTEXT,
            );
          }
        } catch (persistErr) {
          Logger.error(
            `[AdminSources] sourceCode=${String(sourceCode)} created at Viva but ` +
              `local persistence failed for accountId=${id}: ${String(persistErr)}`,
            VIVA_LOG_CONTEXT,
          );
        }
      }

      res.writeHead(201, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify({
          sourceCode: parsed.input.sourceCode,
          name: parsed.input.name,
          kind: parsed.kind,
        }),
      );
    } catch (err) {
      if (err instanceof VivaValidationError) {
        writeError(res, 400, VivaPluginError.channelMisconfigured(err.message));
        return;
      }
      if (err instanceof VivaApiError) {
        const status = err.httpStatus;
        if (typeof status === 'number' && status >= 400 && status < 500) {
          const rawCode =
            err.vivaCode !== undefined ? Number(err.vivaCode) : undefined;
          const opts: Parameters<typeof VivaPluginError.sourceCreationFailed>[0] = {
            message: err.message,
            vivaStatus: status,
            cause: err,
          };
          if (rawCode !== undefined && !Number.isNaN(rawCode)) {
            opts.vivaErrorCode = rawCode;
          }
          writeError(res, 422, VivaPluginError.sourceCreationFailed(opts));
          return;
        }
        if (typeof status === 'number' && status >= 500) {
          writeError(
            res,
            503,
            VivaPluginError.authDown(err.message, err),
          );
          return;
        }
        writeError(
          res,
          502,
          VivaPluginError.apiError({
            message: err.message,
            vivaErrorMessage: err.message,
            cause: err,
          }),
        );
        return;
      }
      Logger.error(
        `[AdminSources] createSource failed for id=${id}: ${String(err)}`,
        VIVA_LOG_CONTEXT,
      );
      writeError(res, 500, VivaPluginError.internalError('Unexpected error', err));
    }
  }
}
