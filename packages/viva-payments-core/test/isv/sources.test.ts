/**
 * IsvSources unit tests.
 *
 * Covers `createEcommerceSource` and `createPhysicalSource`, both POSTing to
 * `/api/sources` on the legacy host with reseller-flavour Basic auth.
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
          return JSON.stringify({ sourceCode: 1234, name: 'Storefront' });
        },
        { headers: { 'Content-Type': 'application/json' } },
      );

    const sources = buildSources(agent);
    const result = await sources.createEcommerceSource({
      domain: 'www.example.com',
      pathSuccess: '/checkout/success',
      pathFail: '/checkout/fail',
      name: 'Storefront',
      sourceCode: 1234,
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
      sourceCode: 1234,
    });
    expect(result.sourceCode).toBe(1234);
    expect(result.name).toBe('Storefront');

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
          return JSON.stringify({ sourceCode: 2000 });
        },
        { headers: { 'Content-Type': 'application/json' } },
      );

    const sources = buildSources(agent);
    await sources.createEcommerceSource({
      domain: 'www.example.com',
      pathSuccess: '/ok',
      pathFail: '/fail',
      name: 'Store',
    });

    expect(capturedBody).not.toBeNull();
    expect(capturedBody!['isSecure']).toBe(true);

    await agent.close();
  });

  it('createEcommerceSource omits sourceCode from body when not set', async () => {
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
          return JSON.stringify({ sourceCode: 3001 });
        },
        { headers: { 'Content-Type': 'application/json' } },
      );

    const sources = buildSources(agent);
    await sources.createEcommerceSource({
      domain: 'www.example.com',
      pathSuccess: '/ok',
      pathFail: '/fail',
      name: 'Store',
    });

    expect(capturedBody).not.toBeNull();
    expect(Object.keys(capturedBody!).sort()).toEqual([
      'domain',
      'isSecure',
      'name',
      'pathFail',
      'pathSuccess',
    ]);

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
        sourceCode: 42, // < 1000
      }),
    ).rejects.toBeInstanceOf(VivaValidationError);

    await expect(
      sources.createEcommerceSource({
        domain: 'www.example.com',
        pathSuccess: '/ok',
        pathFail: '/fail',
        sourceCode: 10_000, // > 9999
      }),
    ).rejects.toBeInstanceOf(VivaValidationError);

    await agent.close();
  });

  it('createPhysicalSource POSTs { isPhysical: true, name, sourceCode? }', async () => {
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
          return JSON.stringify({ sourceCode: 5050, name: 'Counter' });
        },
        { headers: { 'Content-Type': 'application/json' } },
      );

    const sources = buildSources(agent);
    const result = await sources.createPhysicalSource({
      name: 'Counter',
      sourceCode: 5050,
    });

    expect(capturedBody).toEqual({
      isPhysical: true,
      name: 'Counter',
      sourceCode: 5050,
    });
    expect(result.sourceCode).toBe(5050);

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
          return JSON.stringify({ sourceCode: 6060 });
        },
        { headers: { 'Content-Type': 'application/json' } },
      );

    const sources = buildSources(agent);
    await sources.createPhysicalSource({ name: 'Terminal A' });

    expect(capturedBody).not.toBeNull();
    expect(Object.keys(capturedBody!).sort()).toEqual(['isPhysical', 'name']);
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
      })
      .catch((e: unknown) => e)) as VivaApiError;

    expect(err).toBeInstanceOf(VivaApiError);
    expect(err.httpStatus).toBe(422);

    await agent.close();
  });
});
