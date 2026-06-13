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
import { ChannelService, TransactionalConnection } from '@vendure/core';
import type { RequestContext } from '@vendure/core';
import { Channel } from '@vendure/core';
export declare class ConnectedAccountsService {
    private readonly channelService;
    private readonly connection;
    constructor(channelService: ChannelService, connection: TransactionalConnection);
    /**
     * Write `vivaAccountId` on the channel.
     *
     * Called at onboarding-create time (V9) immediately after IsvAccounts.create
     * returns the accountId. This is always the first write for a new channel.
     */
    writeAccountId(ctx: RequestContext, channel: Channel, accountId: string): Promise<void>;
    /**
     * Find a channel where `customFields.vivaAccountId === accountId`.
     *
     * Loads all channels and filters in-process (Vendure doesn't support
     * custom-field WHERE queries natively without raw SQL).
     *
     * Returns null if no channel matches.
     */
    findChannelByAccountId(accountId: string): Promise<Channel | null>;
    /**
     * Write `vivaMerchantId` on the channel.
     *
     * Must be called BEFORE `flipPayoutsEnabled`. Do not reorder.
     */
    writeMerchantId(ctx: RequestContext, channel: Channel, merchantId: string): Promise<void>;
    /**
     * Flip `vivaPayoutsEnabled` on the channel.
     *
     * Must be called AFTER `writeMerchantId` when enabling. Do not reorder.
     */
    flipPayoutsEnabled(ctx: RequestContext, channel: Channel, value: boolean): Promise<void>;
}
//# sourceMappingURL=connected-accounts.service.d.ts.map