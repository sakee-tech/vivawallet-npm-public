/**
 * FastRefundClient unit tests.
 *
 * All HTTP is intercepted by undici MockAgent — no live network.
 *
 * Tests cover:
 *   1.  Successful 200 — request shape (path, method, body, idempotency-key header)
 *       and response parsing into FastRefundResponse.
 *   2.  403 → VivaApiError with httpStatus 403 (caller falls back to standard).
 *   3.  404 → VivaApiError with httpStatus 404.
 *   4.  422 → VivaApiError (BIN invalid / scheme not eligible).
 *   5.  423 → VivaApiError (refund already in progress).
 *   6.  452 → VivaApiError (insufficient funds).
 *   7.  5xx → VivaApiError (non-idempotent: no retry).
 *   8.  Input validation: amount=0, negative, empty merchantTrns, empty idempotencyKey.
 *   9.  URL contains URL-encoded transactionId path segment.
 *   10. Body is JSON with exactly { amount, sourceCode, merchantTrns, idempotencyKey }.
 *
 * @see docs/ENDPOINTS.md §4
 * @see docs/AUTH.md §3.2
 * @see references/payment-api.yaml:9255
 */

import { describe, it, expect } from 'vitest';
import { MockAgent } from 'undici';
import { fetch as undiciFetch } from 'undici';
import { IsvHttpClient } from '../../src/isv/client.js';
import { FastRefundClient } from '../../src/refunds/fast-refund-client.js';
import { VivaApiError } from '../../src/errors/api-error.js';
import { VivaValidationError } from '../../src/errors/validation-error.js';
import type { AuthStrategy } from '../../src/types/auth.js';
import type { TransactionId, MinorUnits } from '../../src/types/common.js';

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

const API_HOST = 'https://demo-api.vivapayments.com';
const TEST_TRANSACTION_ID = 'tx-uuid-9999' as TransactionId;

function makeMockAuthStrategy(): AuthStrategy {
  return {
    name: 'mock-acquiring',
    async getBearerToken(): Promise<string> {
      return 'test-acquiring-bearer';
    },
  };
}

function buildClient(agent: MockAgent): FastRefundClient {
  const fetchImpl = (url: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    return (undiciFetch as unknown as typeof fetch)(url, {
      ...init,
      // @ts-expect-error undici dispatcher option
      dispatcher: agent,
    });
  };

  const http = new IsvHttpClient({
    environment: 'demo',
    authStrategy: makeMockAuthStrategy(),
    fetchImpl,
    retryBackoffsMs: [0, 0, 0],
  });

  return new FastRefundClient({ client: http });
}

function validInput(overrides: Partial<{
  transactionId: TransactionId;
  amount: MinorUnits;
  sourceCode: string;
  merchantTrns: string;
  idempotencyKey: string;
}> = {}) {
  return {
    transactionId: overrides.transactionId ?? TEST_TRANSACTION_ID,
    amount: overrides.amount ?? (500n as MinorUnits),
    sourceCode: overrides.sourceCode ?? 'Default',
    merchantTrns: overrides.merchantTrns ?? 'order-ref-42',
    idempotencyKey: overrides.idempotencyKey ?? 'fastrefund-key-42',
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('FastRefundClient', () => {
  it('200 happy path: POSTs to fastrefund path with correct body and returns parsed response', async () => {
    const agent = new MockAgent();
    agent.disableNetConnect();
    const pool = agent.get(API_HOST);

    let capturedMethod: string | undefined;
    let capturedPath: string | undefined;
    let capturedBody: unknown = null;
    let capturedIdempotencyKey: string | null = null;
    let capturedAuth: string | undefined;

    pool
      .intercept({
        path: `/acquiring/v1/transactions/${TEST_TRANSACTION_ID}:fastrefund`,
        method: 'POST',
      })
      .reply(
        200,
        (opts) => {
          capturedMethod = opts.method;
          capturedPath = opts.path;
          capturedBody = JSON.parse(opts.body as string);
          const headers = opts.headers as Record<string, string> | undefined;
          capturedIdempotencyKey =
            headers?.['idempotency-key'] ?? headers?.['Idempotency-Key'] ?? null;
          capturedAuth = headers?.['authorization'] ?? headers?.['Authorization'];
          return JSON.stringify({
            transactionId: 'refund-tx-abc',
            eventId: 1234,
            amount: 500,
          });
        },
        { headers: { 'Content-Type': 'application/json' } },
      );

    const client = buildClient(agent);
    const result = await client.refund(validInput());

    expect(capturedMethod).toBe('POST');
    expect(capturedPath).toBe(`/acquiring/v1/transactions/${TEST_TRANSACTION_ID}:fastrefund`);
    expect(capturedIdempotencyKey).toBe('fastrefund-key-42');
    expect(capturedAuth).toBe('Bearer test-acquiring-bearer');

    expect(result.transactionId).toBe('refund-tx-abc');
    expect(result.eventId).toBe(1234);
    expect(result.amount).toBe(500);

    expect(capturedBody).toEqual({
      amount: 500, // bigint serialized to number when within safe int range
      sourceCode: 'Default',
      merchantTrns: 'order-ref-42',
      idempotencyKey: 'fastrefund-key-42',
    });

    await agent.close();
  });

  it('403 → throws VivaApiError with httpStatus 403 (caller falls back to standard)', async () => {
    const agent = new MockAgent();
    agent.disableNetConnect();
    const pool = agent.get(API_HOST);

    pool
      .intercept({
        path: `/acquiring/v1/transactions/${TEST_TRANSACTION_ID}:fastrefund`,
        method: 'POST',
      })
      .reply(
        403,
        JSON.stringify({ ErrorCode: 9001, Message: 'merchant not approved for fast refunds' }),
        { headers: { 'Content-Type': 'application/json' } },
      );

    const client = buildClient(agent);
    const err = await client.refund(validInput()).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(VivaApiError);
    expect((err as VivaApiError).httpStatus).toBe(403);

    await agent.close();
  });

  it('404 → throws VivaApiError with httpStatus 404', async () => {
    const agent = new MockAgent();
    agent.disableNetConnect();
    const pool = agent.get(API_HOST);

    pool
      .intercept({
        path: `/acquiring/v1/transactions/${TEST_TRANSACTION_ID}:fastrefund`,
        method: 'POST',
      })
      .reply(404, JSON.stringify({ Message: 'transaction not found' }), {
        headers: { 'Content-Type': 'application/json' },
      });

    const client = buildClient(agent);
    const err = await client.refund(validInput()).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(VivaApiError);
    expect((err as VivaApiError).httpStatus).toBe(404);

    await agent.close();
  });

  it('422 (BIN/scheme invalid) → throws VivaApiError', async () => {
    const agent = new MockAgent();
    agent.disableNetConnect();
    const pool = agent.get(API_HOST);

    pool
      .intercept({
        path: `/acquiring/v1/transactions/${TEST_TRANSACTION_ID}:fastrefund`,
        method: 'POST',
      })
      .reply(422, JSON.stringify({ Message: 'BIN not eligible' }), {
        headers: { 'Content-Type': 'application/json' },
      });

    const client = buildClient(agent);
    const err = await client.refund(validInput()).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(VivaApiError);
    expect((err as VivaApiError).httpStatus).toBe(422);

    await agent.close();
  });

  it('423 (refund already in progress) → throws VivaApiError', async () => {
    const agent = new MockAgent();
    agent.disableNetConnect();
    const pool = agent.get(API_HOST);

    pool
      .intercept({
        path: `/acquiring/v1/transactions/${TEST_TRANSACTION_ID}:fastrefund`,
        method: 'POST',
      })
      .reply(423, JSON.stringify({ Message: 'refund already in progress' }), {
        headers: { 'Content-Type': 'application/json' },
      });

    const client = buildClient(agent);
    const err = await client.refund(validInput()).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(VivaApiError);
    expect((err as VivaApiError).httpStatus).toBe(423);

    await agent.close();
  });

  it('452 (insufficient funds) → throws VivaApiError', async () => {
    const agent = new MockAgent();
    agent.disableNetConnect();
    const pool = agent.get(API_HOST);

    pool
      .intercept({
        path: `/acquiring/v1/transactions/${TEST_TRANSACTION_ID}:fastrefund`,
        method: 'POST',
      })
      .reply(452, JSON.stringify({ Message: 'insufficient funds' }), {
        headers: { 'Content-Type': 'application/json' },
      });

    const client = buildClient(agent);
    const err = await client.refund(validInput()).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(VivaApiError);
    expect((err as VivaApiError).httpStatus).toBe(452);

    await agent.close();
  });

  it('5xx → throws VivaApiError without retry (non-idempotent POST)', async () => {
    const agent = new MockAgent();
    agent.disableNetConnect();
    const pool = agent.get(API_HOST);

    let attempts = 0;
    pool
      .intercept({
        path: `/acquiring/v1/transactions/${TEST_TRANSACTION_ID}:fastrefund`,
        method: 'POST',
      })
      .reply(
        503,
        () => {
          attempts++;
          return JSON.stringify({ Message: 'unavailable' });
        },
        { headers: { 'Content-Type': 'application/json' } },
      );

    const client = buildClient(agent);
    const err = await client.refund(validInput()).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(VivaApiError);
    expect((err as VivaApiError).httpStatus).toBe(503);
    expect(attempts).toBe(1);

    await agent.close();
  });

  it('input validation: rejects amount <= 0, empty merchantTrns, empty idempotencyKey (no HTTP call)', async () => {
    const agent = new MockAgent();
    agent.disableNetConnect();
    // no interceptors registered — any HTTP call would throw

    const client = buildClient(agent);

    await expect(client.refund(validInput({ amount: 0n as MinorUnits }))).rejects.toBeInstanceOf(
      VivaValidationError,
    );
    await expect(client.refund(validInput({ amount: -100n as MinorUnits }))).rejects.toBeInstanceOf(
      VivaValidationError,
    );
    await expect(client.refund(validInput({ merchantTrns: '' }))).rejects.toBeInstanceOf(
      VivaValidationError,
    );
    await expect(client.refund(validInput({ idempotencyKey: '' }))).rejects.toBeInstanceOf(
      VivaValidationError,
    );
    await expect(client.refund(validInput({ sourceCode: '' }))).rejects.toBeInstanceOf(
      VivaValidationError,
    );

    await agent.close();
  });

  it('URL contains URL-encoded transactionId path segment', async () => {
    const agent = new MockAgent();
    agent.disableNetConnect();
    const pool = agent.get(API_HOST);

    // Transaction id with a character that requires encoding. Branded type, so we cast.
    const weirdId = 'tx with space/and+symbols' as TransactionId;
    const encoded = encodeURIComponent(weirdId);

    let capturedPath: string | undefined;
    pool
      .intercept({
        path: `/acquiring/v1/transactions/${encoded}:fastrefund`,
        method: 'POST',
      })
      .reply(
        200,
        (opts) => {
          capturedPath = opts.path;
          return JSON.stringify({ transactionId: 'refund-tx', eventId: 1, amount: 100 });
        },
        { headers: { 'Content-Type': 'application/json' } },
      );

    const client = buildClient(agent);
    await client.refund(validInput({ transactionId: weirdId }));

    expect(capturedPath).toBe(`/acquiring/v1/transactions/${encoded}:fastrefund`);
    expect(capturedPath).toContain('%20'); // space encoded
    expect(capturedPath).not.toContain(' ');

    await agent.close();
  });

  it('request body is exactly { amount, sourceCode, merchantTrns, idempotencyKey } — no extra fields', async () => {
    const agent = new MockAgent();
    agent.disableNetConnect();
    const pool = agent.get(API_HOST);

    let capturedBody: Record<string, unknown> | null = null;
    pool
      .intercept({
        path: `/acquiring/v1/transactions/${TEST_TRANSACTION_ID}:fastrefund`,
        method: 'POST',
      })
      .reply(
        200,
        (opts) => {
          capturedBody = JSON.parse(opts.body as string) as Record<string, unknown>;
          return JSON.stringify({ transactionId: 'refund-tx', eventId: 1, amount: 100 });
        },
        { headers: { 'Content-Type': 'application/json' } },
      );

    const client = buildClient(agent);
    await client.refund(validInput({ amount: 250n as MinorUnits, sourceCode: 'WebStore' }));

    expect(capturedBody).not.toBeNull();
    const body = capturedBody as unknown as Record<string, unknown>;
    expect(Object.keys(body).sort()).toEqual(
      ['amount', 'idempotencyKey', 'merchantTrns', 'sourceCode'].sort(),
    );
    expect(body['amount']).toBe(250);
    expect(body['sourceCode']).toBe('WebStore');
    expect(body['merchantTrns']).toBe('order-ref-42');
    expect(body['idempotencyKey']).toBe('fastrefund-key-42');

    await agent.close();
  });
});
