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
export { FastRefundClient } from './fast-refund-client.js';
export type { FastRefundClientConfig, FastRefundRequest, FastRefundResponse, } from './fast-refund-client.js';
export { resolveRefundStrategy } from './strategy.js';
export type { RefundStrategy, RefundContext, RefundDecision } from './strategy.js';
//# sourceMappingURL=index.d.ts.map