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
    errorCode: ErrorCode!
    message: String!
    vivaErrorCode: Int
    vivaErrorMessage: String
  }

  # Register the plugin's granular error codes as members of Vendure's core
  # ErrorCode enum. ErrorResult.errorCode is typed ErrorCode! (an enum), so the
  # resolver can only return values that exist in the enum — returning a raw
  # string that isn't a member throws at GraphQL serialization. Vendure also
  # auto-adds CANCEL_PAYMENT_ERROR (derived from the type name); these are the
  # reason-level codes the cancelPayment resolver actually emits.
  extend enum ErrorCode {
    AUTHORIZATION_FAILED
    VIVA_AUTH_DOWN
    VIVA_API_ERROR
    VIVA_ACCOUNT_NOT_VERIFIED
    VIVA_ISV_AMOUNT_TOO_HIGH
    VIVA_CHANNEL_MISCONFIGURED
    VIVA_ORDER_NOT_FOUND
    VIVA_AMOUNT_MISMATCH
    VIVA_REFUND_REJECTED
    VIVA_FAST_REFUND_INELIGIBLE
    VIVA_MODE_MISMATCH
    VIVA_PAYMENT_ALREADY_SETTLED
    VIVA_PAYMENT_NOT_CANCELLABLE
    VIVA_ALREADY_ONBOARDED
    VIVA_RESELLER_CREDENTIALS_MISSING
    VIVA_SOURCE_CREATION_FAILED
    VIVA_INTERNAL_ERROR
  }
`);
