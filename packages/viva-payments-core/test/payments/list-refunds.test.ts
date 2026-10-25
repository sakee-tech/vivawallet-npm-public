/**
 * listRefunds — GET /api/transactions?ordercode= on the legacy host (Basic auth).
 *
 * Fixture is the REAL probe-captured body (Viva demo, ISV reseller Basic,
 * 2026-10-25): logs/refund-cap-probe/2026-10-25T09-27-06-857Z/status.json,
 * order 3445737288589019. Parent fab87a1a… (+10 GBP, StatusId R) with three
 * refund rows (−1, −3, −3).
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { MockAgent, fetch as undiciFetch } from 'undici';
import { IsvHttpClient } from '../../src/isv/client.js';
import { BasicAuthClient } from '../../src/legacy/client.js';
import { Payments } from '../../src/payments/client.js';
import { VivaApiError } from '../../src/errors/api-error.js';
import type { OrderCode, TransactionId } from '../../src/types/common.js';

const LEGACY_HOST = 'https://demo.vivapayments.com';
const ORDER_CODE = 3445737288589019n as OrderCode;
const PARENT = 'fab87a1a-e4cb-463e-8f0f-a2155960fb5a' as TransactionId;
const FIXTURE = readFileSync(
  resolve(__dirname, 'fixtures/transactions-ordercode-3445737288589019.json'),
  'utf8',
);

const TAGGED_FIXTURE = readFileSync(
  resolve(__dirname, 'fixtures/transactions-ordercode-3445737288589019-tagged.json'),
  'utf8',
);

function setup(status: number, body: string): { agent: MockAgent; payments: Payments } {
  const agent = new MockAgent();
  agent.disableNetConnect();
  agent
    .get(LEGACY_HOST)
    .intercept({ path: `/api/transactions?ordercode=${ORDER_CODE}`, method: 'GET' })
    .reply(status, body, { headers: { 'Content-Type': 'application/json' } });
  const fetchImpl = ((url: RequestInfo | URL, init?: RequestInit) =>
    (undiciFetch as unknown as typeof fetch)(url, {
      ...init,
      // @ts-expect-error undici dispatcher option
      dispatcher: agent,
    })) as typeof fetch;
  const legacyClient = new BasicAuthClient({
    environment: 'demo',
    merchantId: 'm',
    apiKey: 'k',
    fetchImpl,
    retryBackoffsMs: [0, 0, 0],
  });
  const client = new IsvHttpClient({
    environment: 'demo',
    authStrategy: { name: 'mock', getBearerToken: async () => 't' },
    fetchImpl,
  });
  return { agent, payments: new Payments({ mode: 'isv', client, legacyClient }) };
}

describe('Payments.listRefunds', () => {
  it('returns the 3 refund rows of the parent from the real probe listing, parent excluded', async () => {
    const { agent, payments } = setup(200, FIXTURE);
    const refunds = await payments.listRefunds(ORDER_CODE, PARENT);
    expect(refunds).toEqual([
      {
        transactionId: '3bd220fe-0079-41af-8be5-c4a93042f981',
        amountMinor: 100n,
        insDate: '2026-10-25T11:27:06.527+02:00',
        merchantTrns: null,
      },
      {
        transactionId: '8266e8e5-5b5e-44b6-9b4e-71729244b207',
        amountMinor: 300n,
        insDate: '2026-10-24T17:03:54.14+03:00',
        merchantTrns: null,
      },
      {
        transactionId: '701860e3-ae6b-4e51-946a-128f9f6c0bf4',
        amountMinor: 300n,
        insDate: '2026-10-24T17:03:53.863+03:00',
        merchantTrns: null,
      },
    ]);
    await agent.close();
  });

  it('returns each row MerchantTrns verbatim: full-length tags, null when untagged (real tagged listing)', async () => {
    // logs/refund-cap-probe/2026-10-25T14-11-05-485Z/status.json — refunds sent
    // with a 60- and a 47-char merchantTrns, three sent without, parent tagged
    // with its own order reference (not inherited by refunds).
    const { agent, payments } = setup(200, TAGGED_FIXTURE);
    const refunds = await payments.listRefunds(ORDER_CODE, PARENT);
    expect(refunds.map((r) => [r.transactionId, r.amountMinor, r.merchantTrns])).toEqual([
      ['ba8fbb42-a5b3-4e5f-8a51-77862a3f7d01', 100n, 'probe-trns-66ef3054-3f7e-413a-8521-c280e654e440xxxxxxxxxxxxx'],
      ['1d45e09c-ce48-4f5b-aa79-dc2916c12743', 100n, 'probe-trns-b87744d2-5950-464e-bd0b-26a9bedca511'],
      ['3bd220fe-0079-41af-8be5-c4a93042f981', 100n, null],
      ['8266e8e5-5b5e-44b6-9b4e-71729244b207', 300n, null],
      ['701860e3-ae6b-4e51-946a-128f9f6c0bf4', 300n, null],
    ]);
    expect(refunds[0]!.merchantTrns).toHaveLength(60);
    await agent.close();
  });

  it('ignores refund rows of a different parent (match on ParentId, not order)', async () => {
    const body = JSON.parse(FIXTURE);
    body.Transactions[0].ParentId = 'other-attempt';
    const { agent, payments } = setup(200, JSON.stringify(body));
    const refunds = await payments.listRefunds(ORDER_CODE, PARENT);
    expect(refunds.map((r) => r.amountMinor)).toEqual([300n, 300n]);
    await agent.close();
  });

  it('throws when the parent row is absent (no currency to scale by)', async () => {
    const body = JSON.parse(FIXTURE);
    body.Transactions = body.Transactions.filter((t: { ParentId: unknown }) => t.ParentId !== null);
    const { agent, payments } = setup(200, JSON.stringify(body));
    await expect(payments.listRefunds(ORDER_CODE, PARENT)).rejects.toBeInstanceOf(VivaApiError);
    await agent.close();
  });

  it('throws on a 200-with-failure body (Success:false / ErrorCode 403)', async () => {
    const { agent, payments } = setup(
      200,
      JSON.stringify({ Transactions: null, ErrorCode: 403, ErrorText: 'Forbidden', Success: false }),
    );
    await expect(payments.listRefunds(ORDER_CODE, PARENT)).rejects.toBeInstanceOf(VivaApiError);
    await agent.close();
  });

  it('throws when Transactions is missing or not an array', async () => {
    const { agent, payments } = setup(200, JSON.stringify({ ErrorCode: 0, Success: true }));
    await expect(payments.listRefunds(ORDER_CODE, PARENT)).rejects.toBeInstanceOf(VivaApiError);
    await agent.close();
  });

  it('throws on an HTTP error', async () => {
    const { agent, payments } = setup(403, JSON.stringify({ Message: 'nope' }));
    await expect(payments.listRefunds(ORDER_CODE, PARENT)).rejects.toBeInstanceOf(VivaApiError);
    await agent.close();
  });
});
