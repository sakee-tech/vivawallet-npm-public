import { VendureEvent } from '@vendure/core';
import type { ID, RequestContext } from '@vendure/core';
/**
 * #31: Viva refunded this payment outside Vendure (Self Care / dashboard, or a
 * refund without this plugin's tag), reported by webhook 1797. The plugin
 * records it on its own `viva_transaction` row and counts it in the refund cap;
 * there is no Vendure Refund. The host subscribes to flag the order.
 * `amount` is minor units, from Viva's authenticated refund listing.
 * Published once per Viva refund, after the recording commits.
 */
export declare class VivaExternalRefundEvent extends VendureEvent {
    ctx: RequestContext;
    orderId: ID;
    paymentId: ID;
    amount: number;
    constructor(ctx: RequestContext, orderId: ID, paymentId: ID, amount: number);
}
//# sourceMappingURL=events.d.ts.map