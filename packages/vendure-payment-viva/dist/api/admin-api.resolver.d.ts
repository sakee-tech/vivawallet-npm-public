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
import { RequestContext } from '@vendure/core';
import type { ID, Refund } from '@vendure/core';
export declare const adminApiExtensions: import("graphql").DocumentNode;
export declare class VivaAdminApiResolver {
    checkVivaRefund(ctx: RequestContext, args: {
        refundId: ID;
    }): Promise<Refund>;
}
//# sourceMappingURL=admin-api.resolver.d.ts.map