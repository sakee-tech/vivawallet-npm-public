/**
 * api/admin-onboarding.controller.ts — Connected Accounts onboarding admin REST endpoints.
 *
 * Routes (all under /viva/admin/connected-accounts):
 *
 *   POST   /viva/admin/connected-accounts
 *     Initiate onboarding for a channel. Calls IsvAccounts.createConnectedAccount,
 *     writes vivaAccountId to the channel, returns {accountId, onboardingUrl}.
 *
 *   GET    /viva/admin/connected-accounts/:channelId
 *     Return onboarding status: {accountId, merchantId, payoutsEnabled,
 *     verificationStatus, applePayDomainVerified}.
 *     Optionally hits IsvAccounts.retrieveConnectedAccount (cached 30s) for a
 *     richer verificationStatus when the channel has an accountId.
 *
 *   POST   /viva/admin/connected-accounts/:channelId/reconcile
 *     Manual recovery if webhook 8194 was missed. Calls
 *     IsvAccounts.retrieveConnectedAccount and, if verified, writes vivaMerchantId
 *     then flips vivaPayoutsEnabled=true via ConnectedAccountsService (preserving
 *     the mandatory field-write order).
 *
 * Auth: @Allow(Permission.SuperAdmin) on every handler.
 *
 * Error envelope: every error response is VivaPluginError.toJSON() shape.
 *
 * @see docs/plans/vendure-plugin-v0.md §"API Surface — REST endpoints"
 * @see docs/plans/vendure-plugin-v0.md §"Onboarding Flow (§10)"
 * @see docs/plans/vendure-plugin-v0.md §"Build Plan — V9"
 * @see docs/VENDURE-CONTRACT.MD §10
 */
var __decorate = (this && this.__decorate) || function (decorators, target, key, desc) {
    var c = arguments.length, r = c < 3 ? target : desc === null ? desc = Object.getOwnPropertyDescriptor(target, key) : desc, d;
    if (typeof Reflect === "object" && typeof Reflect.decorate === "function") r = Reflect.decorate(decorators, target, key, desc);
    else for (var i = decorators.length - 1; i >= 0; i--) if (d = decorators[i]) r = (c < 3 ? d(r) : c > 3 ? d(target, key, r) : d(target, key)) || r;
    return c > 3 && r && Object.defineProperty(target, key, r), r;
};
var __metadata = (this && this.__metadata) || function (k, v) {
    if (typeof Reflect === "object" && typeof Reflect.metadata === "function") return Reflect.metadata(k, v);
};
var __param = (this && this.__param) || function (paramIndex, decorator) {
    return function (target, key) { decorator(target, key, paramIndex); }
};
import { Controller, Post, Get, Param, Body, Res, Inject, UseGuards, } from '@nestjs/common';
import { Allow, Permission, TransactionalConnection, RequestContextService, Logger, } from '@vendure/core';
import { AuthGuard } from '@vendure/core';
import { IsvAccounts, IsvHttpClient } from '@sakeetech/viva-payments-core/isv';
import { VivaApiError, VivaAuthError, VivaModeMismatchError, } from '@sakeetech/viva-payments-core/errors';
import { ConnectedAccountsService } from '../services/connected-accounts.service.js';
import { VivaPluginError } from '../util/error-envelope.js';
import { VIVA_PLUGIN_OPTIONS, VIVA_OAUTH2_STRATEGY_TOKEN, VIVA_LOG_CONTEXT, } from '../constants.js';
const STATUS_CACHE_TTL_MS = 30_000;
const retrieveStatusCache = new Map();
function getCachedStatus(accountId) {
    const entry = retrieveStatusCache.get(accountId);
    if (!entry)
        return undefined;
    if (Date.now() > entry.expiresAt) {
        retrieveStatusCache.delete(accountId);
        return undefined;
    }
    return entry.verificationStatus;
}
function setCachedStatus(accountId, status) {
    retrieveStatusCache.set(accountId, {
        verificationStatus: status,
        expiresAt: Date.now() + STATUS_CACHE_TTL_MS,
    });
}
// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
/**
 * Derive the local verificationStatus from channel custom fields.
 *
 * Priority: channel custom fields are the authoritative local state.
 * IsvAccounts.retrieve may supply a richer status, but the local state
 * determines the effective gate (payoutsEnabled). When both disagree,
 * channel custom fields win — they were written by the webhook handler
 * which already called retrieve and validated the response.
 */
function deriveVerificationStatus(cf) {
    if (!cf['vivaAccountId'])
        return 'not_started';
    if (cf['vivaPayoutsEnabled'] === true)
        return 'verified';
    return 'awaiting_kyc';
}
/** Extract typed custom fields from a Channel, defensively. */
function getCustomFields(channel) {
    return channel.customFields ?? {};
}
// ---------------------------------------------------------------------------
// Controller
// ---------------------------------------------------------------------------
let AdminOnboardingController = class AdminOnboardingController {
    options;
    oauth2;
    connection;
    requestContextService;
    connectedAccountsService;
    constructor(options, oauth2, connection, requestContextService, connectedAccountsService) {
        this.options = options;
        this.oauth2 = oauth2;
        this.connection = connection;
        this.requestContextService = requestContextService;
        this.connectedAccountsService = connectedAccountsService;
    }
    // -------------------------------------------------------------------------
    // Private helpers
    // -------------------------------------------------------------------------
    /**
     * Narrow options to ISV mode or throw `VIVA_MODE_MISMATCH`.
     * Onboarding is inherently an ISV-only flow (POST /isv/v1/accounts) — the
     * merchant-mode equivalent is direct Self Care signup with no API surface.
     * Slice C will gate the controller registration itself; slice A throws at
     * runtime entry points.
     */
    isvOptions() {
        if (this.options.mode !== 'isv') {
            throw new VivaModeMismatchError({
                message: 'Connected-Accounts onboarding is ISV-only — POST /isv/v1/accounts ' +
                    'is not available under merchant mode.',
            });
        }
        return this.options;
    }
    buildIsvAccounts() {
        const client = new IsvHttpClient({
            environment: this.options.environment,
            authStrategy: this.oauth2,
        });
        return new IsvAccounts(client);
    }
    /**
     * Load a channel by id from the raw TypeORM connection.
     * Returns null if not found.
     */
    async loadChannel(channelId) {
        const repo = this.connection.rawConnection.getRepository('Channel');
        const ch = await repo.findOne({ where: { id: channelId } }).catch(() => null);
        return ch ?? null;
    }
    /**
     * Map a core SDK error to an HTTP status + VivaPluginError JSON body and
     * write it to the response.
     */
    sendVivaError(res, err) {
        if (err instanceof VivaAuthError || (err instanceof VivaApiError && err.httpStatus >= 500)) {
            const pluginErr = VivaPluginError.authDown(err instanceof Error ? err.message : 'Viva service unavailable', err);
            res.writeHead(503, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify(pluginErr.toJSON()));
            return;
        }
        if (err instanceof VivaApiError) {
            const apiErr = err;
            const rawVivaCode = apiErr.vivaCode !== undefined ? Number(apiErr.vivaCode) : undefined;
            // TODO(impl): VivaApiError.vivaCode is string; confirm wire numeric type from live API.
            const pluginErrOpts = {
                message: apiErr.message,
                vivaErrorMessage: apiErr.message,
                cause: err,
            };
            if (rawVivaCode !== undefined && !isNaN(rawVivaCode)) {
                pluginErrOpts.vivaErrorCode = rawVivaCode;
            }
            const pluginErr = VivaPluginError.apiError(pluginErrOpts);
            const httpStatus = apiErr.httpStatus ?? 422;
            res.writeHead(httpStatus >= 400 && httpStatus < 600 ? httpStatus : 422, {
                'Content-Type': 'application/json',
            });
            res.end(JSON.stringify(pluginErr.toJSON()));
            return;
        }
        // Unexpected internal error
        const pluginErr = VivaPluginError.internalError(err instanceof Error ? err.message : 'Unexpected error', err);
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(pluginErr.toJSON()));
    }
    // -------------------------------------------------------------------------
    // POST /viva/admin/connected-accounts — Initiate onboarding
    // -------------------------------------------------------------------------
    async initiateOnboarding(body, res) {
        const { channelId, overrides } = body ?? {};
        if (!channelId) {
            const err = VivaPluginError.channelMisconfigured('channelId is required');
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify(err.toJSON()));
            return;
        }
        // 1. Load Channel
        const channel = await this.loadChannel(String(channelId));
        if (!channel) {
            const err = VivaPluginError.channelMisconfigured(`Channel ${channelId} not found`);
            res.writeHead(404, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify(err.toJSON()));
            return;
        }
        const cf = getCustomFields(channel);
        // 2. Check Seller exists
        // Vendure Channel has a `seller` relation; surface it from raw TypeORM.
        const channelRepo = this.connection.rawConnection.getRepository('Channel');
        const channelWithSeller = await channelRepo
            .findOne({ where: { id: channel.id }, relations: ['seller'] })
            .catch(() => null);
        const seller = channelWithSeller?.seller;
        if (!seller) {
            const err = VivaPluginError.channelMisconfigured('Channel must have a Seller before onboarding');
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify(err.toJSON()));
            return;
        }
        // 3. Already onboarded?
        const existingAccountId = cf['vivaAccountId'];
        if (existingAccountId) {
            const err = VivaPluginError.alreadyOnboarded(existingAccountId);
            res.writeHead(409, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify(err.toJSON()));
            return;
        }
        // 4. Build payload from Seller fields + plugin config + overrides
        // POST /isv/v1/accounts accepts: email (required), returnUrl (required),
        // branding (optional: partnerName + logoUrl required, primaryColor optional).
        // The ISV API collects countryCode, firstName, lastName, currency, etc. from
        // the merchant during Viva-hosted KYC; the plugin does not forward them.
        const sellerCf = seller['customFields'] ?? {};
        const email = overrides?.email ??
            sellerCf['contactEmail'] ??
            sellerCf['email'] ??
            seller['email'];
        const ctxForResolvers = {
            channelId: channel.id,
            channel: {
                id: channel.id,
                code: channel.code,
                customFields: cf,
            },
            apiType: 'admin',
        };
        const isvOpts = this.isvOptions();
        const returnUrl = overrides?.returnUrl ??
            (typeof isvOpts.onboardingReturnUrl === 'function'
                ? isvOpts.onboardingReturnUrl(ctxForResolvers)
                : isvOpts.onboardingReturnUrl);
        if (!email) {
            const err = VivaPluginError.channelMisconfigured('Seller must have an email (customFields.contactEmail, customFields.email, or seller.email) — or pass `overrides.email`.');
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify(err.toJSON()));
            return;
        }
        if (!returnUrl) {
            const err = VivaPluginError.channelMisconfigured('`onboardingReturnUrl` is required in plugin options (or pass `overrides.returnUrl`).');
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify(err.toJSON()));
            return;
        }
        const basePayload = {
            email,
            returnUrl,
            ...(overrides?.branding
                ? { branding: overrides.branding }
                : isvOpts.onboardingBranding
                    ? { branding: isvOpts.onboardingBranding }
                    : {}),
        };
        Logger.info(`[AdminOnboarding] Initiating onboarding for channel ${String(channel.id)}.`, VIVA_LOG_CONTEXT);
        // 5. Call IsvAccounts.createConnectedAccount
        let accountId;
        let onboardingUrl;
        try {
            const isvAccounts = this.buildIsvAccounts();
            const result = await isvAccounts.createConnectedAccount(basePayload);
            accountId = result.accountId;
            onboardingUrl = result.invitation.redirectUrl;
        }
        catch (err) {
            Logger.error(`[AdminOnboarding] IsvAccounts.createConnectedAccount failed for channel ${String(channel.id)}: ${String(err)}`, VIVA_LOG_CONTEXT);
            this.sendVivaError(res, err);
            return;
        }
        // 6. Write accountId to channel via ConnectedAccountsService
        try {
            const ctx = await this.requestContextService.create({
                apiType: 'admin',
                channelOrToken: channel,
            });
            await this.connectedAccountsService.writeAccountId(ctx, channel, accountId);
        }
        catch (err) {
            Logger.error(`[AdminOnboarding] Failed to write vivaAccountId to channel ${String(channel.id)}: ${String(err)}`, VIVA_LOG_CONTEXT);
            // accountId was created at Viva — still return it so the admin can record it
            Logger.warn(`[AdminOnboarding] accountId=${accountId} was created at Viva but could not be persisted locally. Manual recovery required.`, VIVA_LOG_CONTEXT);
        }
        // 7. Return response
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
            accountId,
            onboardingUrl,
            channelId: channel.id,
            instructions: 'Send onboardingUrl to the shop principal to complete KYC.',
        }));
    }
    // -------------------------------------------------------------------------
    // GET /viva/admin/connected-accounts/:channelId — Onboarding status
    // -------------------------------------------------------------------------
    async getStatus(channelId, res) {
        const channel = await this.loadChannel(channelId);
        if (!channel) {
            const err = VivaPluginError.channelMisconfigured(`Channel ${channelId} not found`);
            res.writeHead(404, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify(err.toJSON()));
            return;
        }
        const cf = getCustomFields(channel);
        const accountId = cf['vivaAccountId'] ?? null;
        const merchantId = cf['vivaMerchantId'] ?? null;
        const payoutsEnabled = cf['vivaPayoutsEnabled'] ?? false;
        const applePayDomainVerified = cf['vivaApplePayDomainVerified'] ?? false;
        // Derive local status from channel fields
        const localStatus = deriveVerificationStatus(cf);
        // Optionally enrich with Viva's status (cached 30s) when accountId is known
        let verificationStatus = localStatus;
        if (accountId) {
            const cached = getCachedStatus(accountId);
            if (cached !== undefined) {
                // Use cached Viva status only for informational display;
                // local field state (payoutsEnabled) governs the actual gate.
                // If Viva says 'verified' but local hasn't flipped yet, local wins.
                // This avoids race conditions during the webhook-write window.
                // Strategy: show the more favorable (local if verified, viva if richer).
                if (payoutsEnabled) {
                    verificationStatus = 'verified';
                }
                else if (cached === 'verified') {
                    // Viva says verified but local webhook hasn't landed yet — show awaiting_kyc
                    // to avoid premature gate flip via a status endpoint poll.
                    // TODO(impl): expose vivaRawStatus as a separate field if SaaS needs it.
                    verificationStatus = 'awaiting_kyc';
                }
            }
            else {
                // Attempt a fresh retrieve — best effort, don't fail the request
                try {
                    const isvAccounts = this.buildIsvAccounts();
                    const retrieved = await isvAccounts.retrieveConnectedAccount(accountId);
                    const rawStatus = retrieved.verified ? 'verified' : 'pending';
                    setCachedStatus(accountId, rawStatus);
                    // Same local-wins rule as above
                    if (payoutsEnabled) {
                        verificationStatus = 'verified';
                    }
                    // rawStatus from Viva does not override local payoutsEnabled flag
                }
                catch (err) {
                    // Best effort — log and proceed with local state
                    Logger.warn(`[AdminOnboarding] IsvAccounts.retrieveConnectedAccount failed for accountId=${accountId}: ${String(err)}`, VIVA_LOG_CONTEXT);
                }
            }
        }
        const payload = {
            channelId: channel.id,
            accountId,
            merchantId,
            payoutsEnabled,
            verificationStatus,
            applePayDomainVerified,
        };
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(payload));
    }
    // -------------------------------------------------------------------------
    // POST /viva/admin/connected-accounts/:channelId/reconcile — Manual recovery
    // -------------------------------------------------------------------------
    async reconcile(channelId, res) {
        const channel = await this.loadChannel(channelId);
        if (!channel) {
            const err = VivaPluginError.channelMisconfigured(`Channel ${channelId} not found`);
            res.writeHead(404, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify(err.toJSON()));
            return;
        }
        const cf = getCustomFields(channel);
        const accountId = cf['vivaAccountId'];
        if (!accountId) {
            const err = VivaPluginError.channelMisconfigured('Channel does not have a vivaAccountId. Initiate onboarding first.');
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify(err.toJSON()));
            return;
        }
        // Already verified — idempotent no-op
        if (cf['vivaPayoutsEnabled'] === true && cf['vivaMerchantId']) {
            const payload = {
                channelId: channel.id,
                accountId,
                merchantId: cf['vivaMerchantId'],
                payoutsEnabled: true,
                verificationStatus: 'verified',
                applePayDomainVerified: cf['vivaApplePayDomainVerified'] ?? false,
            };
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify(payload));
            return;
        }
        // Call IsvAccounts.retrieveConnectedAccount
        let retrieved;
        try {
            const isvAccounts = this.buildIsvAccounts();
            retrieved = await isvAccounts.retrieveConnectedAccount(accountId);
        }
        catch (err) {
            Logger.error(`[AdminOnboarding] reconcile: IsvAccounts.retrieveConnectedAccount failed for channel ${channelId}: ${String(err)}`, VIVA_LOG_CONTEXT);
            this.sendVivaError(res, err);
            return;
        }
        const isVerified = retrieved.verified === true;
        const merchantId = retrieved.merchantId;
        if (isVerified && merchantId) {
            // Write in the mandatory order: vivaMerchantId FIRST, vivaPayoutsEnabled LAST
            try {
                const ctx = await this.requestContextService.create({
                    apiType: 'admin',
                    channelOrToken: channel,
                });
                await this.connectedAccountsService.writeMerchantId(ctx, channel, merchantId);
                await this.connectedAccountsService.flipPayoutsEnabled(ctx, channel, true);
                Logger.info(`[AdminOnboarding] reconcile: wrote merchantId=${merchantId} and flipped payoutsEnabled for channel ${channelId}.`, VIVA_LOG_CONTEXT);
            }
            catch (err) {
                Logger.error(`[AdminOnboarding] reconcile: failed to write channel fields for channel ${channelId}: ${String(err)}`, VIVA_LOG_CONTEXT);
                const pluginErr = VivaPluginError.internalError('Failed to persist reconciliation data', err);
                res.writeHead(500, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify(pluginErr.toJSON()));
                return;
            }
            const payload = {
                channelId: channel.id,
                accountId,
                merchantId,
                payoutsEnabled: true,
                verificationStatus: 'verified',
                applePayDomainVerified: cf['vivaApplePayDomainVerified'] ?? false,
            };
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify(payload));
            return;
        }
        // Viva says still pending — no writes; return current state
        const payload = {
            channelId: channel.id,
            accountId,
            merchantId: cf['vivaMerchantId'] ?? null,
            payoutsEnabled: false,
            verificationStatus: 'awaiting_kyc',
            applePayDomainVerified: cf['vivaApplePayDomainVerified'] ?? false,
        };
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(payload));
    }
};
__decorate([
    Post(),
    Allow(Permission.SuperAdmin),
    __param(0, Body()),
    __param(1, Res()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object, Function]),
    __metadata("design:returntype", Promise)
], AdminOnboardingController.prototype, "initiateOnboarding", null);
__decorate([
    Get(':channelId'),
    Allow(Permission.SuperAdmin),
    __param(0, Param('channelId')),
    __param(1, Res()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String, Function]),
    __metadata("design:returntype", Promise)
], AdminOnboardingController.prototype, "getStatus", null);
__decorate([
    Post(':channelId/reconcile'),
    Allow(Permission.SuperAdmin),
    __param(0, Param('channelId')),
    __param(1, Res()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String, Function]),
    __metadata("design:returntype", Promise)
], AdminOnboardingController.prototype, "reconcile", null);
AdminOnboardingController = __decorate([
    Controller('viva/admin/connected-accounts'),
    UseGuards(AuthGuard),
    __param(0, Inject(VIVA_PLUGIN_OPTIONS)),
    __param(1, Inject(VIVA_OAUTH2_STRATEGY_TOKEN)),
    __metadata("design:paramtypes", [Object, Object, TransactionalConnection,
        RequestContextService,
        ConnectedAccountsService])
], AdminOnboardingController);
export { AdminOnboardingController };
//# sourceMappingURL=admin-onboarding.controller.js.map