"use strict";
/**
 * services/connected-accounts.service.ts — Channel ↔ Viva account helpers.
 *
 * Used by the webhook worker (V7) for event 8194, by the onboarding
 * endpoints (V9), and by the sources controller (writeSourceCode +
 * assignVivaPaymentMethod, to close the onboarding loop). Encapsulates the
 * mandatory field-write order rule:
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
/** Handler code of the plugin's PaymentMethodHandler (see payment-method-handler.ts). */
const VIVA_PAYMENT_METHOD_CODE = 'viva';
// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------
let ConnectedAccountsService = class ConnectedAccountsService {
    channelService;
    connection;
    paymentMethodService;
    constructor(channelService, connection, paymentMethodService) {
        this.channelService = channelService;
        this.connection = connection;
        this.paymentMethodService = paymentMethodService;
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
    /**
     * Write `vivaSourceCode` on the channel after a Smart-Checkout (ecommerce)
     * source is created.
     *
     * The Viva `/api/sources` response returns `sourceCode` as a **number**
     * (4-digit integer), but the channel custom field is declared `type: 'string'`
     * and `Payments.createOrder` puts `sourceCode` on the wire as a string. Coerce
     * with `String()` so a numeric value never lands in the string-typed field
     * (which would then flow onto the create-order wire as a number).
     *
     * Called from the sources controller only for ecommerce sources — physical
     * (POS) source codes must not become the web checkout source.
     */
    async writeSourceCode(ctx, channel, sourceCode) {
        const value = String(sourceCode);
        core_1.Logger.info(`[ConnectedAccounts] Writing vivaSourceCode=${value} to channel ${String(channel.id)}.`, constants_js_1.VIVA_LOG_CONTEXT);
        await this.channelService.update(ctx, {
            id: channel.id,
            customFields: { vivaSourceCode: value },
        });
    }
    /**
     * Assign the global `viva` PaymentMethod to the channel so the storefront's
     * `eligiblePaymentMethods` exposes it.
     *
     * The plugin does not create the PaymentMethod (the host does) — so this
     * looks up the method by its handler code and skips gracefully (logging a
     * warning) when none exists yet. Returns true when an assignment was made.
     */
    async assignVivaPaymentMethod(ctx, channel) {
        const repo = this.connection.rawConnection.getRepository(core_2.PaymentMethod);
        const methods = await repo.find();
        const viva = methods.find((m) => m.handler?.code === VIVA_PAYMENT_METHOD_CODE);
        if (!viva) {
            core_1.Logger.warn(`[ConnectedAccounts] No PaymentMethod with handler code '${VIVA_PAYMENT_METHOD_CODE}' found — ` +
                `cannot assign to channel ${String(channel.id)}. Create the Viva PaymentMethod first.`, constants_js_1.VIVA_LOG_CONTEXT);
            return false;
        }
        core_1.Logger.info(`[ConnectedAccounts] Assigning PaymentMethod '${VIVA_PAYMENT_METHOD_CODE}' (id=${String(viva.id)}) to channel ${String(channel.id)}.`, constants_js_1.VIVA_LOG_CONTEXT);
        await this.paymentMethodService.assignPaymentMethodsToChannel(ctx, {
            paymentMethodIds: [viva.id],
            channelId: channel.id,
        });
        return true;
    }
};
exports.ConnectedAccountsService = ConnectedAccountsService;
exports.ConnectedAccountsService = ConnectedAccountsService = __decorate([
    (0, common_1.Injectable)(),
    __metadata("design:paramtypes", [core_1.ChannelService,
        core_1.TransactionalConnection,
        core_1.PaymentMethodService])
], ConnectedAccountsService);
//# sourceMappingURL=connected-accounts.service.js.map