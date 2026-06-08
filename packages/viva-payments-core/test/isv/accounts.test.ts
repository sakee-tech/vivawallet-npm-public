/**
 * IsvAccounts unit tests.
 *
 * Probe-verified 2026-05-11 against `demo-api.vivapayments.com`. Endpoint paths
 * and response shapes mirror the live API response.
 */

import { describe, it, expect } from 'vitest';
import { MockAgent } from 'undici';
import { fetch as undiciFetch } from 'undici';
import { IsvHttpClient } from '../../src/isv/client.js';
import { IsvAccounts } from '../../src/isv/accounts.js';
import type { AuthStrategy } from '../../src/types/auth.js';
import type { ConnectedAccountId } from '../../src/types/common.js';

const API_HOST = 'https://demo-api.vivapayments.com';
const TEST_ACCOUNT_ID = 'connected-account-uuid-1234' as ConnectedAccountId;

function makeMockAuthStrategy(): AuthStrategy {
  return {
    name: 'mock',
    async getBearerToken(): Promise<string> {
      return 'test-bearer-token';
    },
  };
}

function buildAccounts(agent: MockAgent): IsvAccounts {
  const fetchImpl = (url: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    return (undiciFetch as unknown as typeof fetch)(url, {
      ...init,
      // @ts-expect-error undici dispatcher option
      dispatcher: agent,
    });
  };

  const client = new IsvHttpClient({
    environment: 'demo',
    authStrategy: makeMockAuthStrategy(),
    fetchImpl,
    retryBackoffsMs: [0, 0, 0],
  });

  return new IsvAccounts(client);
}

describe('IsvAccounts', () => {
  it('createConnectedAccount POSTs {email, returnUrl, branding?} to /isv/v1/accounts', async () => {
    const agent = new MockAgent();
    agent.disableNetConnect();
    const pool = agent.get(API_HOST);

    let capturedBody: unknown = null;
    pool
      .intercept({ path: '/isv/v1/accounts', method: 'POST' })
      .reply(
        200,
        (opts) => {
          capturedBody = JSON.parse(opts.body as string);
          return JSON.stringify({
            accountId: TEST_ACCOUNT_ID,
            invitation: {
              email: 'merchant@example.com',
              redirectUrl: 'https://demo-app.vivapayments.com/register/invite/3/' + TEST_ACCOUNT_ID,
              created: '2026-05-11T13:27:03.6992+03:00',
            },
          });
        },
        { headers: { 'Content-Type': 'application/json' } },
      );

    const accounts = buildAccounts(agent);
    const result = await accounts.createConnectedAccount({
      email: 'merchant@example.com',
      returnUrl: 'https://example.com/connected',
      branding: {
        partnerName: 'Acme ISV',
        logoUrl: 'https://example.com/logo.png',
        primaryColor: '#1F2439',
      },
    });

    expect(result.accountId).toBe(TEST_ACCOUNT_ID);
    expect(result.invitation.redirectUrl).toContain('/register/invite/');
    expect(capturedBody).toEqual({
      email: 'merchant@example.com',
      returnUrl: 'https://example.com/connected',
      branding: {
        partnerName: 'Acme ISV',
        logoUrl: 'https://example.com/logo.png',
        primaryColor: '#1F2439',
      },
    });
    await agent.close();
  });

  it('createConnectedAccount omits branding from the wire body when not supplied', async () => {
    const agent = new MockAgent();
    agent.disableNetConnect();
    const pool = agent.get(API_HOST);

    let capturedBody: Record<string, unknown> | null = null;
    pool
      .intercept({ path: '/isv/v1/accounts', method: 'POST' })
      .reply(
        200,
        (opts) => {
          capturedBody = JSON.parse(opts.body as string) as Record<string, unknown>;
          return JSON.stringify({
            accountId: TEST_ACCOUNT_ID,
            invitation: { email: 'merchant2@example.com', redirectUrl: 'https://r.url', created: '2026-05-11T00:00:00Z' },
          });
        },
        { headers: { 'Content-Type': 'application/json' } },
      );

    const accounts = buildAccounts(agent);
    const result = await accounts.createConnectedAccount({
      email: 'merchant2@example.com',
      returnUrl: 'https://example.com/done',
    });

    expect(result.accountId).toBe(TEST_ACCOUNT_ID);
    expect(capturedBody).not.toBeNull();
    expect(Object.keys(capturedBody!)).toEqual(['email', 'returnUrl']);
    await agent.close();
  });

  it('retrieveConnectedAccount GETs /isv/v1/accounts/{accountId} and returns the full shape', async () => {
    const agent = new MockAgent();
    agent.disableNetConnect();
    const pool = agent.get(API_HOST);

    pool
      .intercept({ path: `/isv/v1/accounts/${TEST_ACCOUNT_ID}`, method: 'GET' })
      .reply(
        200,
        JSON.stringify({
          email: null,
          verified: false,
          accountId: TEST_ACCOUNT_ID,
          taxNumber: null,
          vatNumber: null,
          legalName: null,
          merchantId: null,
          acquiringEnabled: false,
          created: null,
          registrationNumber: null,
          invitation: {
            email: 'merchant@example.com',
            redirectUrl: 'https://demo-app.vivapayments.com/register/invite/3/x',
            created: '2026-05-11T00:00:00Z',
          },
        }),
        { headers: { 'Content-Type': 'application/json' } },
      );

    const accounts = buildAccounts(agent);
    const result = await accounts.retrieveConnectedAccount(TEST_ACCOUNT_ID);

    expect(result.accountId).toBe(TEST_ACCOUNT_ID);
    expect(result.verified).toBe(false);
    expect(result.merchantId).toBeNull();
    expect(result.acquiringEnabled).toBe(false);
    expect(result.invitation.email).toBe('merchant@example.com');
    await agent.close();
  });

  it('retrieveConnectedAccount surfaces merchantId once the merchant is verified', async () => {
    const agent = new MockAgent();
    agent.disableNetConnect();
    const pool = agent.get(API_HOST);

    pool
      .intercept({ path: `/isv/v1/accounts/${TEST_ACCOUNT_ID}`, method: 'GET' })
      .reply(
        200,
        JSON.stringify({
          email: 'merchant@example.com',
          verified: true,
          accountId: TEST_ACCOUNT_ID,
          taxNumber: 'TAX-1',
          vatNumber: 'VAT-1',
          legalName: 'Acme Ltd',
          merchantId: 'merchant-uuid-abc',
          acquiringEnabled: true,
          created: '2026-05-10T00:00:00Z',
          registrationNumber: 'REG-1',
          invitation: { email: null, redirectUrl: null, created: null },
        }),
        { headers: { 'Content-Type': 'application/json' } },
      );

    const accounts = buildAccounts(agent);
    const result = await accounts.retrieveConnectedAccount(TEST_ACCOUNT_ID);

    expect(result.verified).toBe(true);
    expect(result.merchantId).toBe('merchant-uuid-abc');
    expect(result.acquiringEnabled).toBe(true);
    expect(result.legalName).toBe('Acme Ltd');
    await agent.close();
  });
});
