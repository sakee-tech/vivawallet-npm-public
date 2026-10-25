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

import { Injectable } from '@nestjs/common';
import {
  ChannelService,
  PaymentMethodService,
  TransactionalConnection,
  Logger,
} from '@vendure/core';
import type { RequestContext } from '@vendure/core';
import { Channel, PaymentMethod } from '@vendure/core';
import { VIVA_LOG_CONTEXT } from '../constants.js';

/** Handler code of the plugin's PaymentMethodHandler (see payment-method-handler.ts). */
const VIVA_PAYMENT_METHOD_CODE = 'viva';

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

@Injectable()
export class ConnectedAccountsService {
  constructor(
    private readonly channelService: ChannelService,
    private readonly connection: TransactionalConnection,
    private readonly paymentMethodService: PaymentMethodService,
  ) {}

  /**
   * Write `vivaAccountId` on the channel.
   *
   * Called at onboarding-create time (V9) immediately after IsvAccounts.create
   * returns the accountId. This is always the first write for a new channel.
   */
  async writeAccountId(ctx: RequestContext, channel: Channel, accountId: string): Promise<void> {
    Logger.info(
      `[ConnectedAccounts] Writing vivaAccountId=${accountId} to channel ${String(channel.id)}.`,
      VIVA_LOG_CONTEXT,
    );
    await this.channelService.update(ctx, {
      id: channel.id,
      customFields: { vivaAccountId: accountId },
    } as any);
  }

  /**
   * Find a channel where `customFields.vivaAccountId === accountId`.
   *
   * Loads all channels and filters in-process (Vendure doesn't support
   * custom-field WHERE queries natively without raw SQL).
   *
   * Returns null if no channel matches.
   */
  async findChannelByAccountId(accountId: string): Promise<Channel | null> {
    const repo = this.connection.rawConnection.getRepository(Channel);
    const channels = await repo.find();
    for (const ch of channels) {
      const cf = (ch as any).customFields as Record<string, unknown> | undefined;
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
  async writeMerchantId(ctx: RequestContext, channel: Channel, merchantId: string): Promise<void> {
    Logger.info(
      `[ConnectedAccounts] Writing vivaMerchantId=${merchantId} to channel ${String(channel.id)}.`,
      VIVA_LOG_CONTEXT,
    );
    // TODO(impl): ChannelService.update in Vendure 3.x accepts a partial UpdateChannelInput.
    // The exact shape of the update payload for customFields depends on the Vendure version
    // and whether the channel custom fields are registered as AdminUI-visible.
    // Line below assumes Vendure 3.6 ChannelService.update signature:
    //   update(ctx, input: DeepPartial<Channel> & { id: ID }): Promise<Channel>
    await this.channelService.update(ctx, {
      id: channel.id,
      customFields: { vivaMerchantId: merchantId },
    } as any);
  }

  /**
   * Flip `vivaPayoutsEnabled` on the channel.
   *
   * Must be called AFTER `writeMerchantId` when enabling. Do not reorder.
   */
  async flipPayoutsEnabled(ctx: RequestContext, channel: Channel, value: boolean): Promise<void> {
    Logger.info(
      `[ConnectedAccounts] Flipping vivaPayoutsEnabled=${value} on channel ${String(channel.id)}.`,
      VIVA_LOG_CONTEXT,
    );
    await this.channelService.update(ctx, {
      id: channel.id,
      customFields: { vivaPayoutsEnabled: value },
    } as any);
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
  async writeSourceCode(
    ctx: RequestContext,
    channel: Channel,
    sourceCode: number | string,
  ): Promise<void> {
    const value = String(sourceCode);
    Logger.info(
      `[ConnectedAccounts] Writing vivaSourceCode=${value} to channel ${String(channel.id)}.`,
      VIVA_LOG_CONTEXT,
    );
    await this.channelService.update(ctx, {
      id: channel.id,
      customFields: { vivaSourceCode: value },
    } as any);
  }

  /**
   * Assign the global `viva` PaymentMethod to the channel so the storefront's
   * `eligiblePaymentMethods` exposes it.
   *
   * The plugin does not create the PaymentMethod (the host does) — so this
   * looks up the method by its handler code and skips gracefully (logging a
   * warning) when none exists yet. Returns true when an assignment was made.
   */
  async assignVivaPaymentMethod(ctx: RequestContext, channel: Channel): Promise<boolean> {
    const repo = this.connection.rawConnection.getRepository(PaymentMethod);
    const methods = await repo.find();
    const viva = methods.find(
      (m) => (m as PaymentMethod).handler?.code === VIVA_PAYMENT_METHOD_CODE,
    );
    if (!viva) {
      Logger.warn(
        `[ConnectedAccounts] No PaymentMethod with handler code '${VIVA_PAYMENT_METHOD_CODE}' found — ` +
          `cannot assign to channel ${String(channel.id)}. Create the Viva PaymentMethod first.`,
        VIVA_LOG_CONTEXT,
      );
      return false;
    }
    Logger.info(
      `[ConnectedAccounts] Assigning PaymentMethod '${VIVA_PAYMENT_METHOD_CODE}' (id=${String(viva.id)}) to channel ${String(channel.id)}.`,
      VIVA_LOG_CONTEXT,
    );
    await this.paymentMethodService.assignPaymentMethodsToChannel(ctx, {
      paymentMethodIds: [viva.id],
      channelId: channel.id,
    });
    return true;
  }
}
