/**
 * Webhook event types and payloads for the Viva Wallet ISV integration.
 *
 * Covers: WebhookEnvelope<T> generic, EVENT_TYPES const object, and typed
 * EventData payloads for v1-scope event types:
 *   1796 — Transaction Payment Created
 *   1797 — Transaction Reversal Created
 *   1798 — Transaction Failed
 *   4865 — Order Updated (cancellation)
 *   8193 — Account Connected
 *   8194 — Account Verification Status Changed
 *
 * @see references/viva-docs/md/webhooks-for-payments.txt:141
 * @see references/viva-docs/md/wh-transaction-payment-created.txt:158
 * @see references/viva-docs/md/wh-transaction-failed.txt:162
 * @see references/viva-docs/md/wh-account-connected.txt:150
 * @see references/viva-docs/md/wh-account-verif-status-changed.txt:152
 */

import type { CurrencyCode, TransactionId, OrderCode } from './common.js';

// ---------------------------------------------------------------------------
// EventTypeId const object (not a TypeScript enum)
// ---------------------------------------------------------------------------

/**
 * v1-scope Viva Webhook event type identifiers.
 *
 * Defined as `as const` object per requirement 4 — NOT a TypeScript enum.
 * This avoids TypeScript enum pitfalls (numeric reverse-mapping, etc.).
 *
 * @see references/viva-docs/md/webhooks-for-payments.txt:141
 */
export const EVENT_TYPES = {
  /** A customer payment has been successful. */
  TRANSACTION_PAYMENT_CREATED: 1796,
  /** A customer refund has been successfully actioned. */
  TRANSACTION_REVERSAL_CREATED: 1797,
  /** A customer payment failed. */
  TRANSACTION_FAILED: 1798,
  /** An order was cancelled (API or Smart Checkout back button). */
  ORDER_UPDATED: 4865,
  /** An account is successfully connected to the ISV account. */
  ACCOUNT_CONNECTED: 8193,
  /** Verification status of a connected account changed. */
  ACCOUNT_VERIFICATION_STATUS_CHANGED: 8194,
} as const;

/**
 * Union type of all v1-scope EventTypeId numeric values.
 */
export type VivaEventTypeId = (typeof EVENT_TYPES)[keyof typeof EVENT_TYPES];

/**
 * Deferred event type IDs — documented for future implementation.
 * NOT in v1 scope per plan A8 and the narrowed event-type set.
 *
 * @see references/viva-docs/md/webhooks-for-payments.txt:141
 */
export const DEFERRED_EVENT_TYPES = {
  /** Commission payment withdrawn by Viva. Post-v1. */
  TRANSACTION_PRICE_CALCULATED: 1799,
  /** ECR integration only. Post-v1. */
  TRANSACTION_POS_ECR_SESSION_CREATED: 1802,
  /** ECR integration only. Post-v1. */
  TRANSACTION_POS_ECR_SESSION_FAILED: 1803,
  /** Wallet account balance change. Post-v1. */
  ACCOUNT_TRANSACTION_CREATED: 2054,
  /** Bank transfer created. Post-v1. */
  COMMAND_BANK_TRANSFER_CREATED: 768,
  /** Bank transfer executed. Post-v1. */
  COMMAND_BANK_TRANSFER_EXECUTED: 769,
  /** Marketplace-only: a transfer has been made. Post-v1. */
  TRANSFER_CREATED: 8448,
} as const;

// ---------------------------------------------------------------------------
// Webhook envelope
// ---------------------------------------------------------------------------

/**
 * Generic webhook envelope shape.
 *
 * All Viva webhook POSTs share the same outer envelope; only `EventData`
 * varies by event type.
 *
 * Observed in two different docs:
 * - wh-transaction-payment-created.txt line 158: has `RetryCount` and
 *   `RetryDelayInSeconds` at the top level (inside EventData AND envelope).
 * - wh-account-connected.txt line 150: does NOT show RetryCount at top level,
 *   only inside EventData.
 *
 * TODO(impl): verify whether RetryCount/RetryDelayInSeconds are envelope-level
 * fields on all event types or only on transaction events. Cross-check against
 * live demo payload.
 * @see references/viva-docs/md/wh-transaction-payment-created.txt:252
 * @see references/viva-docs/md/wh-account-connected.txt:159
 *
 * The `Delay` field is documented as `string` in wh-account-connected.txt:231
 * but shown as `null` in the example. Typed as `string | null`.
 */
export interface WebhookEnvelope<T> {
  /** The webhook URL that received this notification. */
  readonly Url: string;
  /**
   * The event-specific payload. Type varies by EventTypeId.
   *
   * @see references/viva-docs/md/wh-transaction-payment-created.txt:158
   */
  readonly EventData: T;
  /**
   * ISO 8601 UTC timestamp when the notification was initially created.
   * Used for the 25-hour freshness check (plan A12).
   *
   * @see references/viva-docs/md/wh-transaction-payment-created.txt:252
   */
  readonly Created: string;
  /**
   * Viva internal tracking ID for cross-system log correlation.
   * Store as `correlation_id` on structured log lines (plan A13).
   *
   * @see references/viva-docs/md/wh-account-connected.txt:159
   */
  readonly CorrelationId: string;
  /**
   * The type of event that triggered this notification.
   *
   * @see references/viva-docs/md/webhooks-for-payments.txt:141
   */
  readonly EventTypeId: number;
  /**
   * Delay timespan for messages sent at a future date (null for immediate).
   *
   * @see references/viva-docs/md/wh-account-connected.txt:161
   */
  readonly Delay: string | null;
  /**
   * Unique identifier of this message delivery.
   * Used for deduplication at the DB layer (UNIQUE constraint on message_id).
   *
   * @see references/viva-docs/md/wh-account-connected.txt:164
   */
  readonly MessageId: string;
  /**
   * The recipient of the webhook (typically the ISV account Merchant ID).
   *
   * @see references/viva-docs/md/wh-account-connected.txt:165
   */
  readonly RecipientId: string;
  /**
   * Message type: always 512 (0x200) for merchant webhooks.
   *
   * @see references/viva-docs/md/wh-account-connected.txt:166
   */
  readonly MessageTypeId: number;
  /**
   * Number of retry attempts so far (0 on first delivery).
   *
   * TODO(impl): verify RetryCount is present on ALL event type envelopes,
   * not just transaction events. wh-account-connected.txt does not show it
   * in the response example but wh-transaction-payment-created.txt does.
   * @see references/viva-docs/md/wh-transaction-payment-created.txt:255
   */
  readonly RetryCount?: number;
  /**
   * Delay in seconds between retries. Null on first delivery.
   *
   * @see references/viva-docs/md/wh-transaction-payment-created.txt:257
   */
  readonly RetryDelayInSeconds?: number | null;
}

// ---------------------------------------------------------------------------
// Transaction event data (shared base for 1796, 1797, 1798)
// ---------------------------------------------------------------------------

/**
 * Base shape for transaction event data (EventTypeId 1796, 1797, 1798).
 *
 * All three share the same flat structure. Differences:
 * - 1796: StatusId is typically 'F' (Finished/captured)
 * - 1797: StatusId is typically 'R' (Refunded); ParentId links to original
 * - 1798: StatusId is typically 'E' (Error)
 *
 * Amount ambiguity: the docs show `Amount: decimal` in the description text
 * (webhooks-for-payments.txt:483) but the createOrder request uses integer
 * minor units. The sample payloads show integer values (Amount: 10, 1000).
 *
 * TODO(impl): verify Amount unit (minor int vs major decimal) against first
 * real demo payment. Treat as minor units until confirmed otherwise.
 * @see references/viva-docs/md/wh-transaction-payment-created.txt:344
 *
 * @see references/viva-docs/md/wh-transaction-payment-created.txt:158
 */
export interface TransactionEventData {
  /** The TransactionId of the transaction. */
  readonly TransactionId: TransactionId;
  /** The OrderCode of the transaction. */
  readonly OrderCode: OrderCode;
  /**
   * Status letter. See VivaStatusLetter in status.ts.
   *
   * @see references/viva-docs/md/wh-transaction-payment-created.txt:398
   */
  readonly StatusId: string;
  /**
   * Signed amount of the transaction. Represents total funds paid by the
   * customer (includes TotalFee).
   *
   * TODO(impl): verify unit — docs say decimal, sample shows integer.
   * Assuming minor units. Treat as number on wire, convert to bigint on ingest.
   * @see references/viva-docs/md/wh-transaction-payment-created.txt:344
   */
  readonly Amount: number;
  /**
   * ISO 4217 numeric currency code string.
   *
   * @see references/viva-docs/md/wh-transaction-payment-created.txt:487
   */
  readonly CurrencyCode: CurrencyCode;
  /** MerchantId of the merchant. Used for tenant routing. */
  readonly MerchantId: string;
  /**
   * ConnectedAccountId (ISV schema). May be null if not ISV-scoped.
   * Used for onboarding event tenant routing.
   *
   * @see references/viva-docs/md/wh-transaction-payment-created.txt:224
   */
  readonly ConnectedAccountId: string | null;
  /** Parent TransactionId (if this is a reversal/refund). */
  readonly ParentId: TransactionId | null;
  /** ISO 8601 timestamp when the transaction occurred. */
  readonly InsDate: string;
  /** Transaction type numeric identifier (5 = CardCharge, 4 = Refund, etc.). */
  readonly TransactionTypeId: number;
  /** Customer email. May be masked. */
  readonly Email: string | null;
  /** Customer full name. */
  readonly FullName: string | null;
  /** Masked card number (e.g. "414746XXXXXX0133"). */
  readonly CardNumber: string | null;
  /**
   * Card type: 0=Visa, 1=Mastercard, 2=Diners, 3=Amex, 4=Invalid,
   * 5=Unknown, 6=Maestro, 7=Discover, 8=JCB.
   *
   * @see references/viva-docs/md/wh-transaction-payment-created.txt:770
   */
  readonly CardTypeId: number;
  /** Merchant transaction reference. */
  readonly MerchantTrns: string | null;
  /** Customer transaction reference. */
  readonly CustomerTrns: string | null;
  /** Source code of the Merchant's payment source. */
  readonly SourceCode: string;
  /** Total fees (signed). */
  readonly TotalFee: number;
  /** Card expiration date in ISO 8601 format. */
  readonly CardExpirationDate: string | null;
  /** Two-letter ISO country code of the card-issuing country. */
  readonly CardCountryCode: string | null;
  /** Name of the card-issuing bank. */
  readonly CardIssuingBank: string | null;
  /**
   * Viva-internal EventId of the transaction, used for Viva's internal
   * operations logging. Present on 1798 failures, but it is NOT a public
   * decline-reason code — the decline reason is carried in `ResponseCode`.
   *
   * @see references/viva-docs/md/wh-transaction-failed.txt:243
   */
  readonly ResponseEventId: number | null;
  /** Order tags. */
  readonly Tags: readonly string[];
  /** Reseller ID if applicable. */
  readonly ResellerId: string | null;
  readonly ResellerCompanyName: string | null;
  readonly ResellerSourceCode: string | null;
  readonly ResellerSourceAddress: string | null;
  readonly CompanyName: string;
  readonly CompanyTitle: string;
  readonly AuthorizationId: string;
  readonly ReferenceNumber: number;
  readonly ResponseCode: string | null;
  /** Whether this is a Mail Order / Telephone Order transaction. */
  readonly Moto: boolean;
  readonly DualMessage: boolean;
  readonly TipAmount: number;
  readonly TotalInstallments: number;
  readonly CurrentInstallment: number;
  readonly ElectronicCommerceIndicator: string | null;
  /** Digital wallet type ID (2=Apple Pay, 3=Google Pay, 4=Samsung Pay). */
  readonly DigitalWalletId: number | null;
  readonly BinId: number;
  readonly IsDcc: boolean;
  /** DCC conversion rate. */
  readonly ConversionRate: number;
  readonly OriginalAmount: number;
  readonly OriginalCurrencyCode: CurrencyCode | null;
  readonly OrderCulture: string;
  readonly CardToken: string | null;
  readonly CardUniqueReference: string | null;
  readonly TargetPersonId: string | null;
  readonly TargetWalletId: string | null;
  readonly SourceName: string;
  readonly Latitude: number | null;
  readonly Longitude: number | null;
  readonly BatchId: string | null;
  readonly PanEntryMode: string;
  readonly BankId: string;
  readonly ChannelId: string;
  readonly TerminalId: number;
  readonly ProductId: string | null;
  readonly Descriptor: string | null;
  readonly Switching: boolean;
  readonly Systemic: boolean;
  readonly AcquirerApproved: boolean;
  readonly LoyaltyTriggered: boolean;
  readonly RedeemedAmount: number;
  readonly SurchargeAmount: number | null;
  readonly ClearanceDate: string | null;
  readonly Ucaf: string | null;
  readonly IsManualRefund: boolean;
  readonly BillId: string | null;
  readonly MerchantCategoryCode: number | null;
  readonly ExternalTransactionId: string | null;
  readonly RetrievalReferenceNumber: string | null;
  readonly AssignedMerchantUsers: readonly string[];
  readonly AssignedResellerUsers: readonly string[];
  readonly CardProductCategoryId: number | null;
  readonly CardProductAccountTypeId: number | null;
  readonly OrderServiceId: number;
  readonly ApplicationIdentifierTerminal: string | null;
  readonly IntegrationId: number | null;
  readonly PrimaryAccountNumberLast4Digits: string | null;
  readonly ServiceId: number | null;
  readonly ResellerSourceName: string | null;
  readonly DccSessionId: string | null;
  readonly DccMarkup: number | null;
  readonly DccDifferenceOverEcb: number | null;
}

// ---------------------------------------------------------------------------
// Typed event data per EventTypeId
// ---------------------------------------------------------------------------

/**
 * EventData for Transaction Payment Created (EventTypeId 1796).
 * StatusId is typically 'F' (Finished/captured).
 *
 * @see references/viva-docs/md/wh-transaction-payment-created.txt:158
 */
export type TransactionPaymentCreatedEventData = TransactionEventData;

/**
 * EventData for Transaction Reversal Created (EventTypeId 1797).
 * StatusId is typically 'R' (Refunded).
 * ParentId references the original transaction.
 *
 * @see references/viva-docs/md/webhooks-for-payments.txt:167
 */
export type TransactionReversalCreatedEventData = TransactionEventData;

/**
 * EventData for Transaction Failed (EventTypeId 1798).
 * StatusId is typically 'E' (Error).
 * ResponseEventId indicates the failure reason.
 *
 * @see references/viva-docs/md/wh-transaction-failed.txt:162
 */
export type TransactionFailedEventData = TransactionEventData;

/**
 * EventData for Order Updated (EventTypeId 4865).
 *
 * Sent when an order is cancelled via Smart Checkout's back button or the
 * cancel-order API. The EventData shape may differ from transaction events.
 *
 * TODO(impl): verify exact EventData fields for 4865 Order Updated.
 * The webhooks-for-payments.txt doc lists it but does not show a sample.
 * wh-transaction-payment-created.txt and wh-transaction-failed.txt cover
 * 1796/1798; no dedicated 4865 doc exists in the local mirror.
 * @see references/viva-docs/md/webhooks-for-payments.txt:207
 */
export interface OrderUpdatedEventData {
  /** The order code of the updated/cancelled order. */
  readonly OrderCode: OrderCode;
  /**
   * The merchant ID for tenant routing.
   * TODO(impl): confirm MerchantId is present on 4865 payload.
   * @see references/viva-docs/md/webhooks-for-payments.txt:207
   */
  readonly MerchantId?: string;
  /**
   * Raw event data — preserved as unknown for forensics until shape confirmed.
   * TODO(impl): replace with fully typed fields once 4865 sample payload obtained.
   */
  readonly raw?: unknown;
}

/**
 * EventData for Account Connected (EventTypeId 8193).
 *
 * @see references/viva-docs/md/wh-account-connected.txt:150
 */
export interface AccountConnectedEventData {
  /** ID of the created person/merchant. */
  readonly PersonId: string;
  /**
   * The ID of the primary wallet created for the merchant.
   * Stored as number (int64 on the wire); use BigInt if precision matters.
   *
   * @see references/viva-docs/md/wh-account-connected.txt:154
   */
  readonly WalletId: number;
  /** ID of the ISV platform account. */
  readonly PlatformPersonId: string;
  /**
   * Connected account ID (UUID). Use for tenant routing on onboarding events.
   *
   * @see references/viva-docs/md/wh-account-connected.txt:155
   */
  readonly ConnectedAccountId: string;
}

/**
 * EventData for Account Verification Status Changed (EventTypeId 8194).
 *
 * @see references/viva-docs/md/wh-account-verif-status-changed.txt:152
 */
export interface AccountVerificationStatusChangedEventData {
  /**
   * True if the account is now verified.
   *
   * @see references/viva-docs/md/wh-account-verif-status-changed.txt:155
   */
  readonly Verified: boolean;
  /** ID of the created person/merchant. */
  readonly PersonId: string;
  /** ID of the ISV platform account. */
  readonly PlatformPersonId: string;
  /**
   * Connected account ID (UUID). Use for tenant routing on onboarding events.
   *
   * @see references/viva-docs/md/wh-account-verif-status-changed.txt:158
   */
  readonly ConnectedAccountId: string;
}

// ---------------------------------------------------------------------------
// Discriminated envelope union
// ---------------------------------------------------------------------------

/**
 * Discriminated union of all typed webhook envelopes for v1-scope event types.
 * Switch on `EventTypeId` to narrow to the specific EventData type.
 *
 * @see references/viva-docs/md/webhooks-for-payments.txt:141
 */
export type VivaWebhookEnvelope =
  | WebhookEnvelope<TransactionPaymentCreatedEventData> & { readonly EventTypeId: 1796 }
  | WebhookEnvelope<TransactionReversalCreatedEventData> & { readonly EventTypeId: 1797 }
  | WebhookEnvelope<TransactionFailedEventData> & { readonly EventTypeId: 1798 }
  | WebhookEnvelope<OrderUpdatedEventData> & { readonly EventTypeId: 4865 }
  | WebhookEnvelope<AccountConnectedEventData> & { readonly EventTypeId: 8193 }
  | WebhookEnvelope<AccountVerificationStatusChangedEventData> & { readonly EventTypeId: 8194 };
