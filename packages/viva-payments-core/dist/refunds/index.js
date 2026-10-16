"use strict";
/**
 * viva-payments-core/refunds — barrel export.
 *
 * Subpath: `@sakeetech/viva-payments-core/refunds`
 *
 * Public surface:
 *   - {@link FastRefundClient} — OAuth2 acquiring-scopes wrapper for
 *     `POST /acquiring/v1/transactions/{transactionId}:fastrefund`.
 *   - {@link resolveRefundStrategy} — pure decision function for the
 *     `auto | fast | standard` strategy resolver consumed by adapters.
 *
 * @see docs/plans/multi-mode-v0.md §8.5a
 * @see docs/ENDPOINTS.md §4
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.resolveRefundStrategy = exports.FastRefundClient = void 0;
var fast_refund_client_js_1 = require("./fast-refund-client.js");
Object.defineProperty(exports, "FastRefundClient", { enumerable: true, get: function () { return fast_refund_client_js_1.FastRefundClient; } });
var strategy_js_1 = require("./strategy.js");
Object.defineProperty(exports, "resolveRefundStrategy", { enumerable: true, get: function () { return strategy_js_1.resolveRefundStrategy; } });
//# sourceMappingURL=index.js.map