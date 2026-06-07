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

import { parse } from 'graphql';

export const shopApiExtensions = parse(`
  extend type Mutation {
    """
    Cancel a Vendure payment by ID. Voids the Viva-side authorization
    (DELETE /checkout/v2/orders/{orderCode}) AND transitions the order back
    to AddingItems. Storefront calls this on ?paymentCancelled=1.
    Permission: order owner (active customer or active anonymous order).
    """
    cancelPayment(paymentId: ID!): CancelPaymentResult!
  }

  union CancelPaymentResult = Order | CancelPaymentError

  type CancelPaymentError implements ErrorResult {
    errorCode: String!
    message: String!
    vivaErrorCode: Int
    vivaErrorMessage: String
  }
`);
