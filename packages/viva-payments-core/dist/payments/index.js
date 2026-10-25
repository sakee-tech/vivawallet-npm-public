"use strict";
/**
 * viva-payments-core/payments — barrel export.
 *
 * Subpath: `viva-payments-core/payments`
 *
 * The Payments client wraps Viva's payment surface (createOrder,
 * retrieveTransaction, refundPayment, cancelOrder). Constructed with an
 * IsvHttpClient (OAuth2) and optionally a BasicAuthClient (for refund).
 *
 * @see references/viva-docs/md/payment-isv-api.txt:1
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.Payments = void 0;
var client_js_1 = require("./client.js");
Object.defineProperty(exports, "Payments", { enumerable: true, get: function () { return client_js_1.Payments; } });
//# sourceMappingURL=index.js.map