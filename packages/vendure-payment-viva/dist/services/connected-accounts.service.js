"use strict";
/**
 * services/connected-accounts.service.ts — Channel ↔ Viva account helpers.
 *
 * Used by the webhook worker (V7) for event 8194 and by the onboarding
 * endpoints (V9). Encapsulates the mandatory field-write order rule:
 *
 *   1. vivaMerchantId  (write FIRST — storefront does NOT gate on this)
 *   2. vivaPayoutsEnabled = true  (write LAST — storefront gates on this)
 *
 * Writing in reverse order would create a race window where the storefront
 * sees payoutsEnabled=true but vivaMerchantId is still null, causing every
 * createPayment to fail with VIVA_CHANNEL_MISCONFIGURED.
 *
 * @see docs/plans/vendure-plugin-v0.md §"Webhook Design — Process flow" step 4 (8194)
 * @see docs/VENDURE-CONTRACT.MD §10 (field-write order)
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
Object.defineProperty(exports, "__esModule", { value: true });
exports.ConnectedAccountsService = void 0;
const common_1 = require("@nestjs/common");
const core_1 = require("@vendure/core");
const core_2 = require("@vendure/core");
const constants_js_1 = require("../constants.js");
// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------
let ConnectedAccountsService = class ConnectedAccountsService {
    channelService;
    connection;
    constructor(channelService, connection) {
        this.channelService = channelService;
        this.connection = connection;
    }
    /**
     * Write `vivaAccountId` on the channel.
     *
     * Called at onboarding-create time (V9) immediately after IsvAccounts.create
     * returns the accountId. This is always the first write for a new channel.
     */
    async writeAccountId(ctx, channel, accountId) {
        core_1.Logger.info(`[ConnectedAccounts] Writing vivaAccountId=${accountId} to channel ${String(channel.id)}.`, constants_js_1.VIVA_LOG_CONTEXT);
        await this.channelService.update(ctx, {
            id: channel.id,
            customFields: { vivaAccountId: accountId },
        });
    }
    /**
     * Find a channel where `customFields.vivaAccountId === accountId`.
     *
     * Loads all channels and filters in-process (Vendure doesn't support
     * custom-field WHERE queries natively without raw SQL).
     *
     * Returns null if no channel matches.
     */
    async findChannelByAccountId(accountId) {
        const repo = this.connection.rawConnection.getRepository(core_2.Channel);
        const channels = await repo.find();
        for (const ch of channels) {
            const cf = ch.customFields;
            if (cf && cf['vivaAccountId'] === accountId) {
                return ch;
            }
        }
        return null;
    }
    /**
     * Write `vivaMerchantId` on the channel.
     *
     * Must be called BEFORE `flipPayoutsEnabled`. Do not reorder.
     */
    async writeMerchantId(ctx, channel, merchantId) {
        core_1.Logger.info(`[ConnectedAccounts] Writing vivaMerchantId=${merchantId} to channel ${String(channel.id)}.`, constants_js_1.VIVA_LOG_CONTEXT);
        // TODO(impl): ChannelService.update in Vendure 3.x accepts a partial UpdateChannelInput.
        // The exact shape of the update payload for customFields depends on the Vendure version
        // and whether the channel custom fields are registered as AdminUI-visible.
        // Line below assumes Vendure 3.6 ChannelService.update signature:
        //   update(ctx, input: DeepPartial<Channel> & { id: ID }): Promise<Channel>
        await this.channelService.update(ctx, {
            id: channel.id,
            customFields: { vivaMerchantId: merchantId },
        });
    }
    /**
     * Flip `vivaPayoutsEnabled` on the channel.
     *
     * Must be called AFTER `writeMerchantId` when enabling. Do not reorder.
     */
    async flipPayoutsEnabled(ctx, channel, value) {
        core_1.Logger.info(`[ConnectedAccounts] Flipping vivaPayoutsEnabled=${value} on channel ${String(channel.id)}.`, constants_js_1.VIVA_LOG_CONTEXT);
        await this.channelService.update(ctx, {
            id: channel.id,
            customFields: { vivaPayoutsEnabled: value },
        });
    }
};
exports.ConnectedAccountsService = ConnectedAccountsService;
exports.ConnectedAccountsService = ConnectedAccountsService = __decorate([
    (0, common_1.Injectable)(),
    __metadata("design:paramtypes", [core_1.ChannelService,
        core_1.TransactionalConnection])
], ConnectedAccountsService);
//# sourceMappingURL=connected-accounts.service.js.map