/**
 * api/admin-api.resolver.ts — `checkVivaRefund(refundId)` Admin API mutation (#5).
 *
 * Staff press "Check refund status" on a Pending Viva refund (the refund call
 * got no clear answer). Viva's listing decides: tagged refund found → Settled;
 * none → Failed (a fresh refund is then safe); listing fails → error, stays
 * Pending. Permission: UpdateOrder, the same as Vendure's refundOrder /
 * settleRefund. `@Transaction()` like Vendure's own refund mutations, so the row
 * bookkeeping and the Refund transition commit together.
 */

import { Resolver, Mutation, Args } from '@nestjs/graphql';
import { parse } from 'graphql';
import { Allow, Ctx, Permission, RequestContext, Transaction } from '@vendure/core';
import type { ID, Refund } from '@vendure/core';
import { checkVivaRefund, failVivaRefund } from '../payment-method-handler.js';

export const adminApiExtensions = parse(`
  extend type Mutation {
    """
    Check a Pending Viva refund against Viva's refund listing: Settled when Viva
    has it, Failed when Viva has no refund with its key. Errors (and the refund
    stays Pending) when Viva can't be asked. A non-Pending refund is returned as is.
    """
    checkVivaRefund(refundId: ID!): Refund!
  }
`);

@Resolver()
export class VivaAdminApiResolver {
  @Transaction()
  @Mutation()
  @Allow(Permission.UpdateOrder)
  async checkVivaRefund(@Ctx() ctx: RequestContext, @Args() args: { refundId: ID }): Promise<Refund> {
    const { outcome, refund } = await checkVivaRefund(ctx, args.refundId);
    return outcome === 'absent' ? failVivaRefund(ctx, refund) : refund;
  }
}
