/**
 * viva-payments-core/types — barrel re-export.
 *
 * Subpath: `viva-payments-core/types`
 *
 * Re-exports all types consumed by S2 (auth), S3 (isv), S4 (webhooks),
 * and S6/S8 (medusa adapter).
 *
 * Attribution: types hand-rolled fresh. Structure partially referenced from
 * @nkhind/vivawallet-sdk for API surface awareness — no code copied.
 */

export type {
  // common.ts
  CurrencyCode,
  MinorUnits,
  Money,
  MerchantId,
  ConnectedAccountId,
  TransactionId,
  OrderCode,
  VivaEnvironment,
  VivaEnvironmentUrls,
  PaginatedResponse,
  PaginationLinks,
} from './common.js';

export {
  // common.ts — runtime values
  asCurrencyCode,
  CURRENCY_CODES,
  ENVIRONMENT_URLS,
  LEGACY_HOST,
} from './common.js';

export type {
  // auth.ts
  OAuth2TokenResponse,
  CachedToken,
  ResellerBasicAuthCredentials,
  AuthStrategy,
} from './auth.js';

export type {
  // isv-payments.ts
  CreateOrderRequest,
  CreateOrderResponse,
  RetrieveTransactionResponse,
  RefundRequest,
  RefundResponse,
  CancelOrderResponse,
} from './isv-payments.js';

export {
  // card-types.ts — runtime values
  CARD_TYPE_BY_ID,
  resolveCardType,
} from './card-types.js';

export type {
  // isv-accounts.ts
  CreateConnectedAccountRequest,
  CreateConnectedAccountResponse,
  GetConnectedAccountResponse,
  RegisterWebhookRequest,
  RetrieveWebhookKeyResponse,
} from './isv-accounts.js';

export type {
  // status.ts
  VivaStatusLetter,
  VivaTransactionStatus,
  VivaClaimSubstate,
  StatusLetterToTransactionStatus,
  ClaimStatusLetter,
  TerminalVivaTransactionStatus,
  NonTerminalVivaTransactionStatus,
  StatusTransition,
  StatusTransitionResult,
} from './status.js';

export type {
  // webhook-events.ts
  WebhookEnvelope,
  VivaEventTypeId,
  TransactionEventData,
  TransactionPaymentCreatedEventData,
  TransactionReversalCreatedEventData,
  TransactionFailedEventData,
  OrderUpdatedEventData,
  AccountConnectedEventData,
  AccountVerificationStatusChangedEventData,
  VivaWebhookEnvelope,
} from './webhook-events.js';

export {
  // webhook-events.ts — runtime values
  EVENT_TYPES,
  DEFERRED_EVENT_TYPES,
} from './webhook-events.js';
