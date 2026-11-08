"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.VivaExternalRefundEvent = void 0;
const core_1 = require("@vendure/core");
/**
 * #31: Viva refunded this payment outside Vendure (Self Care / dashboard, or a
 * refund without this plugin's tag), reported by webhook 1797. The plugin
 * records it on its own `viva_transaction` row and counts it in the refund cap;
 * there is no Vendure Refund. The host subscribes to flag the order.
 * `amount` is minor units, from Viva's authenticated refund listing.
 * Published once per Viva refund, after the recording commits.
 */
class VivaExternalRefundEvent extends core_1.VendureEvent {
    ctx;
    orderId;
    paymentId;
    amount;
    constructor(ctx, orderId, paymentId, amount) {
        super();
        this.ctx = ctx;
        this.orderId = orderId;
        this.paymentId = paymentId;
        this.amount = amount;
    }
}
exports.VivaExternalRefundEvent = VivaExternalRefundEvent;
//# sourceMappingURL=events.js.map