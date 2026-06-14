/**
 * IsvSources unit tests.
 *
 * Covers `createEcommerceSource` and `createPhysicalSource`, both POSTing to
 * `/api/sources` on the legacy host with reseller-flavour Basic auth.
 *
 * Viva's `POST /api/sources` returns HTTP 200 with NO body
 * (payment-isv-api.yaml:279-284). Both methods return `void`; `sourceCode`
 * is a required caller-supplied input (not read from the response).
 *
 * @see docs/ENDPOINTS.md §5.1
 */

import { describe, it, expect } from 'vitest';
import { MockAgent } from 'undici';
import { fetch as undiciFetch } from 'undici';
import { BasicAuthClient } from '../../src/legacy/client.js';
import { IsvSources } from '../../src/isv/sources.js';
import { VivaApiError } from '../../src/errors/api-error.js';
import { VivaValidationError } from '../../src/errors/validation-error.js';

const LEGACY_HOST = 'https://demo.vivapayments.com';

function buildSources(agent: MockAgent): IsvSources {
  const fetchImpl = (url: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    return (undiciFetch as unknown as typeof fetch)(url, {
      ...init,
      // @ts-expect-error undici dispatcher option
      dispatcher: agent,
    });
  };
  const basic = new BasicAuthClient({
    authVariant: 'reseller',
    environment: 'demo',
    resellerId: 'reseller-uuid-1',
    merchantId: 'merchant-uuid-1',
    resellerApiKey: 'reseller-key-1',
    fetchImpl,
    retryBackoffsMs: [0, 0, 0],
  });
  return new IsvSources(basic);
}

describe('IsvSources', () => {
  it('createEcommerceSource POSTs to /api/sources with the expected body', async () => {
    const agent = new MockAgent();
    agent.disableNetConnect();
    const pool = agent.get(LEGACY_HOST);

    let capturedPath = '';
    let capturedMethod = '';
    let capturedBody: Record<string, unknown> | null = null;
    let capturedContentType = '';

    pool
      .intercept({ path: '/api/sources', method: 'POST' })
      .reply(
        200,
        (opts) => {
          capturedPath = opts.path as string;
          capturedMethod = opts.method as string;
          capturedBody = JSON.parse(opts.body as string) as Record<string, unknown>;
          const headers = opts.headers as Record<string, string> | undefined;
          capturedContentType =
            headers?.['content-type'] ?? headers?.['Content-Type'] ?? '';
          // Real Viva API returns HTTP 200 with no body (payment-isv-api.yaml:279-284)
          return '';
        },
        { headers: { 'Content-Type': 'application/json' } },
      );

    const sources = buildSources(agent);
    await sources.createEcommerceSource({
      domain: 'www.example.com',
      pathSuccess: '/checkout/success',
      pathFail: '/checkout/fail',
      name: 'Storefront',
      sourceCode: '1234',
      isSecure: true,
    });

    expect(capturedPath).toBe('/api/sources');
    expect(capturedMethod).toBe('POST');
    expect(capturedContentType).toContain('application/json');
    expect(capturedBody).toEqual({
      domain: 'www.example.com',
      isSecure: true,
      pathFail: '/checkout/fail',
      pathSuccess: '/checkout/success',
      name: 'Storefront',
      sourceCode: '1234',
    });
    // No assertions on response body — Viva returns empty 200. Caller uses
    // the input sourceCode they supplied (1234), not a response field.

    await agent.close();
  });

  it('createEcommerceSource — resolves void on empty-body 200 (real Viva API behaviour)', async () => {
    const agent = new MockAgent();
    agent.disableNetConnect();
    const pool = agent.get(LEGACY_HOST);

    pool
      .intercept({ path: '/api/sources', method: 'POST' })
      .reply(200, '', { headers: { 'Content-Type': 'application/json' } });

    const sources = buildSources(agent);
    // Must resolve to undefined — the API gives no body, sourceCode is caller-supplied
    await expect(
      sources.createEcommerceSource({
        domain: 'www.example.com',
        pathSuccess: '/checkout/success',
        pathFail: '/checkout/fail',
        name: 'Storefront',
        sourceCode: '1234',
      }),
    ).resolves.toBeUndefined();

    await agent.close();
  });

  it('createEcommerceSource defaults isSecure to true when omitted', async () => {
    const agent = new MockAgent();
    agent.disableNetConnect();
    const pool = agent.get(LEGACY_HOST);

    let capturedBody: Record<string, unknown> | null = null;
    pool
      .intercept({ path: '/api/sources', method: 'POST' })
      .reply(
        200,
        (opts) => {
          capturedBody = JSON.parse(opts.body as string) as Record<string, unknown>;
          return '';
        },
        { headers: { 'Content-Type': 'application/json' } },
      );

    const sources = buildSources(agent);
    await sources.createEcommerceSource({
      domain: 'www.example.com',
      pathSuccess: '/ok',
      pathFail: '/fail',
      name: 'Store',
      sourceCode: '2000',
    });

    expect(capturedBody).not.toBeNull();
    expect(capturedBody!['isSecure']).toBe(true);

    await agent.close();
  });

  it('createEcommerceSource always includes sourceCode in the request body (required field)', async () => {
    const agent = new MockAgent();
    agent.disableNetConnect();
    const pool = agent.get(LEGACY_HOST);

    let capturedBody: Record<string, unknown> | null = null;
    pool
      .intercept({ path: '/api/sources', method: 'POST' })
      .reply(
        200,
        (opts) => {
          capturedBody = JSON.parse(opts.body as string) as Record<string, unknown>;
          return '';
        },
        { headers: { 'Content-Type': 'application/json' } },
      );

    const sources = buildSources(agent);
    await sources.createEcommerceSource({
      domain: 'www.example.com',
      pathSuccess: '/ok',
      pathFail: '/fail',
      name: 'Store',
      sourceCode: '3001',
    });

    expect(capturedBody).not.toBeNull();
    // sourceCode is required and must always appear in the request body
    expect(Object.keys(capturedBody!).sort()).toEqual([
      'domain',
      'isSecure',
      'name',
      'pathFail',
      'pathSuccess',
      'sourceCode',
    ]);
    expect(capturedBody!['sourceCode']).toBe('3001');

    await agent.close();
  });

  it('createEcommerceSource validation: empty domain throws VivaValidationError', async () => {
    const agent = new MockAgent();
    agent.disableNetConnect();

    const sources = buildSources(agent);
    await expect(
      sources.createEcommerceSource({
        domain: '',
        pathSuccess: '/ok',
        pathFail: '/fail',
        name: 'Store',
        sourceCode: '1234',
      }),
    ).rejects.toBeInstanceOf(VivaValidationError);

    await agent.close();
  });

  it('createEcommerceSource validation: empty pathSuccess throws VivaValidationError', async () => {
    const agent = new MockAgent();
    agent.disableNetConnect();

    const sources = buildSources(agent);
    await expect(
      sources.createEcommerceSource({
        domain: 'www.example.com',
        pathSuccess: '',
        pathFail: '/fail',
        name: 'Store',
        sourceCode: '1234',
      }),
    ).rejects.toBeInstanceOf(VivaValidationError);

    await agent.close();
  });

  it('createEcommerceSource validation: empty pathFail throws VivaValidationError', async () => {
    const agent = new MockAgent();
    agent.disableNetConnect();

    const sources = buildSources(agent);
    await expect(
      sources.createEcommerceSource({
        domain: 'www.example.com',
        pathSuccess: '/ok',
        pathFail: '',
        name: 'Store',
        sourceCode: '1234',
      }),
    ).rejects.toBeInstanceOf(VivaValidationError);

    await agent.close();
  });

  it('createEcommerceSource validation: missing name throws VivaValidationError (Viva marks name required)', async () => {
    const agent = new MockAgent();
    agent.disableNetConnect();

    const sources = buildSources(agent);
    await expect(
      sources.createEcommerceSource({
        domain: 'www.example.com',
        pathSuccess: '/ok',
        pathFail: '/fail',
        name: '',
        sourceCode: '1234',
      }),
    ).rejects.toBeInstanceOf(VivaValidationError);

    await agent.close();
  });

  it('createEcommerceSource validation: sourceCode out of range throws', async () => {
    const agent = new MockAgent();
    agent.disableNetConnect();

    const sources = buildSources(agent);
    await expect(
      sources.createEcommerceSource({
        domain: 'www.example.com',
        pathSuccess: '/ok',
        pathFail: '/fail',
        name: 'Store',
        sourceCode: '42', // wrong length (not 4 digits)
      }),
    ).rejects.toBeInstanceOf(VivaValidationError);

    await expect(
      sources.createEcommerceSource({
        domain: 'www.example.com',
        pathSuccess: '/ok',
        pathFail: '/fail',
        name: 'Store',
        sourceCode: '10000', // wrong length (5 digits)
      }),
    ).rejects.toBeInstanceOf(VivaValidationError);

    await agent.close();
  });

  it('createPhysicalSource POSTs { isPhysical: true, name, sourceCode }', async () => {
    const agent = new MockAgent();
    agent.disableNetConnect();
    const pool = agent.get(LEGACY_HOST);

    let capturedBody: Record<string, unknown> | null = null;
    pool
      .intercept({ path: '/api/sources', method: 'POST' })
      .reply(
        200,
        (opts) => {
          capturedBody = JSON.parse(opts.body as string) as Record<string, unknown>;
          // Real Viva API returns HTTP 200 with no body (payment-isv-api.yaml:279-284)
          return '';
        },
        { headers: { 'Content-Type': 'application/json' } },
      );

    const sources = buildSources(agent);
    await sources.createPhysicalSource({
      name: 'Counter',
      sourceCode: '5050',
    });

    expect(capturedBody).toEqual({
      isPhysical: true,
      name: 'Counter',
      sourceCode: '5050',
    });
    // No assertions on response body — Viva returns empty 200.

    await agent.close();
  });

  it('createPhysicalSource — resolves void on empty-body 200 (real Viva API behaviour)', async () => {
    const agent = new MockAgent();
    agent.disableNetConnect();
    const pool = agent.get(LEGACY_HOST);

    pool
      .intercept({ path: '/api/sources', method: 'POST' })
      .reply(200, '', { headers: { 'Content-Type': 'application/json' } });

    const sources = buildSources(agent);
    await expect(
      sources.createPhysicalSource({ name: 'Terminal A', sourceCode: '6060' }),
    ).resolves.toBeUndefined();

    await agent.close();
  });

  it('createPhysicalSource body does NOT include domain/pathSuccess/pathFail', async () => {
    const agent = new MockAgent();
    agent.disableNetConnect();
    const pool = agent.get(LEGACY_HOST);

    let capturedBody: Record<string, unknown> | null = null;
    pool
      .intercept({ path: '/api/sources', method: 'POST' })
      .reply(
        200,
        (opts) => {
          capturedBody = JSON.parse(opts.body as string) as Record<string, unknown>;
          return '';
        },
        { headers: { 'Content-Type': 'application/json' } },
      );

    const sources = buildSources(agent);
    await sources.createPhysicalSource({ name: 'Terminal A', sourceCode: '6060' });

    expect(capturedBody).not.toBeNull();
    expect(Object.keys(capturedBody!).sort()).toEqual(['isPhysical', 'name', 'sourceCode']);
    expect(capturedBody!['domain']).toBeUndefined();
    expect(capturedBody!['pathSuccess']).toBeUndefined();
    expect(capturedBody!['pathFail']).toBeUndefined();

    await agent.close();
  });

  it('4xx response from Viva propagates as VivaApiError', async () => {
    const agent = new MockAgent();
    agent.disableNetConnect();
    const pool = agent.get(LEGACY_HOST);

    pool
      .intercept({ path: '/api/sources', method: 'POST' })
      .reply(422, '{"ErrorCode": 4001, "Message": "Source already exists"}', {
        headers: { 'Content-Type': 'application/json' },
      });

    const sources = buildSources(agent);
    const err = (await sources
      .createEcommerceSource({
        domain: 'www.example.com',
        pathSuccess: '/ok',
        pathFail: '/fail',
        name: 'Store',
        sourceCode: '1234',
      })
      .catch((e: unknown) => e)) as VivaApiError;

    expect(err).toBeInstanceOf(VivaApiError);
    expect(err.httpStatus).toBe(422);

    await agent.close();
  });
});
