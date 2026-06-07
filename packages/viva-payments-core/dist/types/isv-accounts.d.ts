/**
 * ISV Connected Account + Webhook Registration types.
 *
 * Probe-verified 2026-05-11 against `docs/payment-isv-api.yaml`. All shapes
 * below match the live demo response observed at `demo-api.vivapayments.com`.
 *
 * Endpoints (all Bearer auth, OAuth2 scopes
 * `urn:viva:payments:core:api:isv urn:viva:payments:core:api:redirectcheckout`):
 *
 *   - POST /isv/v1/accounts                 — create connected account
 *   - GET  /isv/v1/accounts/{accountId}     — retrieve connected account
 *   - POST /isv/v1/webhooks                 — register webhook (204 No Content)
 *   - GET  /isv/v1/webhooks/token           — generate verification key
 *
 * Endpoints NOT in the ISV spec (intentionally absent from this module):
 *
 *   - List webhooks  (not exposed; CLI must rely on POST idempotency)
 *   - Update/Delete webhook  (not exposed; manage via banking UI)
 *   - Update connected account  (not exposed for ISV; merchant edits via UI)
 */
import type { ConnectedAccountId } from './common.js';
/**
 * Request body for `POST /isv/v1/accounts`.
 *
 * Probe-verified shape. The ISV API does NOT accept `countryCode`, `firstName`,
 * `lastName`, `currency`, `sendOnboardingEmail`, or `merchantType` — Viva
 * collects all of those from the merchant during KYC via the invitation URL.
 */
export interface CreateConnectedAccountRequest {
    /** Merchant email address; the invitation link is sent here. */
    readonly email: string;
    /** URL the merchant returns to after completing the Viva-hosted onboarding flow. */
    readonly returnUrl: string;
    /**
     * Optional ISV branding shown on Viva's onboarding pages.
     * `partnerName` and `logoUrl` are required when `branding` is present.
     */
    readonly branding?: {
        readonly partnerName: string;
        readonly logoUrl: string;
        /** Hex code, e.g. `#1F2439`. */
        readonly primaryColor?: string;
    };
}
/**
 * Response from `POST /isv/v1/accounts` (HTTP 200).
 *
 * Probe-verified shape. The onboarding URL lives at `invitation.redirectUrl`
 * — not at a top-level `redirectUrl` field.
 */
export interface CreateConnectedAccountResponse {
    readonly accountId: ConnectedAccountId;
    readonly invitation: {
        readonly email: string;
        /** Viva-hosted onboarding URL. Only functional in production. */
        readonly redirectUrl: string;
        /** ISO 8601 timestamp. */
        readonly created: string;
    };
}
/**
 * Response from `GET /isv/v1/accounts/{accountId}` (HTTP 200).
 *
 * Probe-verified shape. All scalar fields are nullable when the account has
 * not been verified — `merchantId` is the field consumers care about most;
 * it remains `null` until `verified === true`.
 */
export interface GetConnectedAccountResponse {
    readonly accountId: ConnectedAccountId;
    /** Populated only after KYC is complete. Use as `merchantId` query param on createOrder. */
    readonly merchantId: string | null;
    readonly email: string | null;
    /** `true` once Viva has verified the merchant via KYC/KYB. */
    readonly verified: boolean;
    /** `true` when the merchant can accept card payments. Maps to `vivaPayoutsEnabled` locally. */
    readonly acquiringEnabled: boolean;
    readonly created: string | null;
    readonly taxNumber: string | null;
    readonly vatNumber: string | null;
    readonly legalName: string | null;
    readonly registrationNumber: string | null;
    readonly invitation: {
        readonly email: string | null;
        readonly redirectUrl: string | null;
        readonly created: string | null;
    };
}
/**
 * Request body for `POST /isv/v1/webhooks`.
 *
 * Probe-verified shape. The spec does NOT include `isActive` — the API has no
 * concept of inactive webhook registrations.
 */
export interface RegisterWebhookRequest {
    /** Numeric Viva EventTypeId (e.g. 1796 = Transaction Payment Created). */
    readonly eventTypeId: number;
    /** HTTPS URL that will receive webhook POST notifications. */
    readonly url: string;
}
/**
 * Response from `GET /isv/v1/webhooks/token` (HTTP 200).
 *
 * The returned `key` must be echoed in the URL-verify GET handshake on the
 * webhook endpoint so Viva can confirm ownership.
 */
export interface RetrieveWebhookKeyResponse {
    readonly key: string;
}
//# sourceMappingURL=isv-accounts.d.ts.map