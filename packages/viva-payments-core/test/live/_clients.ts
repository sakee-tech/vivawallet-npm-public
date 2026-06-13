/**
 * Client factories for the LIVE suite.
 *
 * Builds the real `@sakeetech/viva-payments-core` classes against demo creds
 * pulled from `process.env`. Imports from `../../src/**` (TS source) so the
 * live suite exercises the exact code under development — not a stale `dist`.
 */

import {
  OAuth2ClientCredentialsStrategy,
  InMemoryTokenCache,
  AsyncMutex,
} from '../../src/auth/index.js';
import { IsvHttpClient } from '../../src/isv/client.js';
import { IsvAccounts } from '../../src/isv/accounts.js';
import { IsvWebhooks } from '../../src/isv/webhooks-api.js';
import { IsvSources } from '../../src/isv/sources.js';
import { Payments } from '../../src/payments/client.js';
import { FastRefundClient } from '../../src/refunds/fast-refund-client.js';
import { BasicAuthClient } from '../../src/legacy/client.js';
import { ENVIRONMENT, requireEnv } from './_env.js';

export function makeIsvOAuthStrategy(): OAuth2ClientCredentialsStrategy {
  return new OAuth2ClientCredentialsStrategy({
    environment: ENVIRONMENT,
    clientId: requireEnv('VIVA_ISV_CLIENT_ID'),
    clientSecret: requireEnv('VIVA_ISV_CLIENT_SECRET'),
    cache: new InMemoryTokenCache(),
    mutex: new AsyncMutex(),
  });
}

export function makeSingleOAuthStrategy(): OAuth2ClientCredentialsStrategy {
  return new OAuth2ClientCredentialsStrategy({
    environment: ENVIRONMENT,
    clientId: requireEnv('VIVA_SINGLE_OAUTH_CLIENT_ID'),
    clientSecret: requireEnv('VIVA_SINGLE_OAUTH_CLIENT_SECRET'),
    cache: new InMemoryTokenCache(),
    mutex: new AsyncMutex(),
  });
}

export function makeIsvClient(
  strategy = makeIsvOAuthStrategy(),
): IsvHttpClient {
  return new IsvHttpClient({ environment: ENVIRONMENT, authStrategy: strategy });
}

export function makeSingleClient(): IsvHttpClient {
  return new IsvHttpClient({
    environment: ENVIRONMENT,
    authStrategy: makeSingleOAuthStrategy(),
  });
}

/** ISV-mode Payments (createOrder/retrieve/cancel against /checkout/v2/isv/**). */
export function makeIsvPayments(client = makeIsvClient()): Payments {
  return new Payments({ mode: 'isv', client });
}

/** Merchant-mode Payments for the single-merchant OAuth identity. */
export function makeMerchantPayments(client = makeSingleClient()): Payments {
  return new Payments({ mode: 'merchant', client });
}

export function makeIsvAccounts(client = makeIsvClient()): IsvAccounts {
  return new IsvAccounts(client);
}

export function makeIsvWebhooks(client = makeIsvClient()): IsvWebhooks {
  return new IsvWebhooks(client);
}

export function makeFastRefundClient(client = makeIsvClient()): FastRefundClient {
  return new FastRefundClient({ client });
}

/** Merchant Basic-auth client (single-merchant API key) — webhook key, refund. */
export function makeMerchantBasicClient(): BasicAuthClient {
  return new BasicAuthClient({
    authVariant: 'merchant',
    environment: ENVIRONMENT,
    merchantId: requireEnv('VIVA_SINGLE_MERCHANT_ID'),
    apiKey: requireEnv('VIVA_SINGLE_MERCHANT_API_KEY'),
  });
}

/** Reseller Basic-auth client (3-part ISV creds) — used for /api/sources. */
export function makeResellerBasicClient(): BasicAuthClient {
  return new BasicAuthClient({
    authVariant: 'reseller',
    environment: ENVIRONMENT,
    resellerId: requireEnv('VIVA_ISV_RESELLER_ID'),
    merchantId: requireEnv('VIVA_ISV_MERCHANT_ID'),
    resellerApiKey: requireEnv('VIVA_ISV_RESELLER_API_KEY'),
  });
}

export function makeIsvSources(
  basic = makeResellerBasicClient(),
): IsvSources {
  return new IsvSources(basic);
}
