/**
 * api/shop-api.extension.ts — GraphQL Shop API schema extension.
 *
 * Adds the `cancelPayment(paymentId)` mutation to the Shop API.
 * `Order` is Vendure's existing built-in entity; `ErrorResult` interface
 * is already in scope from @vendure/core so `CancelPaymentError implements
 * ErrorResult` is valid without re-declaring the interface.
 *
 * Wired into plugin via `shopApiExtensions.schema` (see plugin.ts).
 *
 * @see docs/plans/vendure-plugin-v0.md §"API Surface — Shop API extension"
 * @see docs/plans/vendure-plugin-v0.md §"Build Plan — V8"
 */
export declare const shopApiExtensions: import("graphql").DocumentNode;
//# sourceMappingURL=shop-api.extension.d.ts.map