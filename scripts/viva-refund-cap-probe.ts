#!/usr/bin/env tsx
/**
 * ISV refund cap + idempotencyKey probe (issue techsakee20/vivawallet#2).
 *
 * Questions:
 *   A. Full refund sent twice on one payment — does Viva reject the 2nd?
 *   B. £3 partial sent four times on a £10 payment — is the cap cumulative
 *      (4th = £12 total must fail)?
 *   C. £3 partial sent twice with the SAME `idempotencyKey` query param — does
 *      the 2nd return the 1st result without moving money? Then once with a new
 *      key as a control.
 *
 * Usage (demo env, ISV reseller creds from repo-root .env):
 *   pnpm exec tsx scripts/viva-refund-cap-probe.ts orders
 *     → creates 3 ISV orders of £10, prints checkout URLs. Pay each with the
 *       demo success card 4147 4630 1111 0133 and note the `t=` (transactionId)
 *       from the success redirect.
 *   pnpm exec tsx scripts/viva-refund-cap-probe.ts refund <txnA> <txnB> <txnC>
 *     → runs scenarios A/B/C; full raw responses go to
 *       logs/refund-cap-probe/<ts>/results.json (git-ignored).
 *
 *   pnpm exec tsx scripts/viva-refund-cap-probe.ts status <orderCode...>
 *     → order state + the deprecated ?ordercode= transaction listing (refund
 *       rows carry ParentId); saved to logs/refund-cap-probe/<ts>/status.json.
 *   pnpm exec tsx scripts/viva-refund-cap-probe.ts retry <txnId> <amountMinor> <key|new> [orderCode]
 *     → ONE refund with the given idempotencyKey ('new' = fresh key), saved to
 *       retry.json; with orderCode, also runs status for it. Previous-day probe
 *       (2026-10-25) on payment C, key from 2026-10-24T14-03-54-220Z/results.json:
 *         retry fab87a1a-e4cb-463e-8f0f-a2155960fb5a 300 probe-a763ef59-c6f4-4fe0-9f7b-4a6e92de81ea 3445737288589019
 *         retry fab87a1a-e4cb-463e-8f0f-a2155960fb5a 100 new 3445737288589019
 *   pnpm exec tsx scripts/viva-refund-cap-probe.ts trns <txnId> <amountMinor> <controlRefundId> [tagLen] [orderCode]
 *     (tagLen pads the merchantTrns key to N chars; orderCode also runs status)
 *     → ONE refund sending merchantTrns=<key>, then reads it (and a control refund
 *       sent without merchantTrns) back via legacy + v2 retrieve; saved to trns.json.
 *       Asks whether a retry can tell our refund from a dashboard refund (#2).
 *
 * Caveat: same-day refunds on Viva are "Cancel / Reverse" (spec), not
 * previous-day "Refund / Void". Results describe the same-day path.
 */

import '../packages/viva-payments-core/test/live/_setup.js';
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
// viva-payments-core is CommonJS: ESM named imports fail, take the default
// (module.exports). test/live/_clients.ts + _env.ts import vitest, so the
// clients are built here the same way (same env vars, same defaults).
import authMod from '../packages/viva-payments-core/src/auth/index.js';
import isvClientMod from '../packages/viva-payments-core/src/isv/client.js';
import paymentsMod from '../packages/viva-payments-core/src/payments/client.js';
import legacyMod from '../packages/viva-payments-core/src/legacy/client.js';
import commonMod from '../packages/viva-payments-core/src/types/common.js';
import type { MerchantId } from '../packages/viva-payments-core/src/types/common.js';

const { OAuth2ClientCredentialsStrategy, InMemoryTokenCache, AsyncMutex } = authMod;
const { IsvHttpClient } = isvClientMod;
const { Payments } = paymentsMod;
const { BasicAuthClient } = legacyMod;
const { asCurrencyCode } = commonMod;

const ENVIRONMENT = (process.env['VIVA_ENVIRONMENT'] ?? 'demo') as 'demo' | 'production';
const DEMO_ISV_MERCHANT_ID = process.env['VIVA_ISV_MERCHANT_ID'] || '5cf789ee-6b1b-46ab-a71f-03ffdb912c9a';

function requireEnv(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`missing env ${name}`);
  return v;
}

function makeIsvPayments() {
  const authStrategy = new OAuth2ClientCredentialsStrategy({
    environment: ENVIRONMENT,
    clientId: requireEnv('VIVA_ISV_CLIENT_ID'),
    clientSecret: requireEnv('VIVA_ISV_CLIENT_SECRET'),
    cache: new InMemoryTokenCache(),
    mutex: new AsyncMutex(),
  });
  return new Payments({ mode: 'isv', client: new IsvHttpClient({ environment: ENVIRONMENT, authStrategy }) });
}

function makeResellerBasicClient() {
  return new BasicAuthClient({
    authVariant: 'reseller',
    environment: ENVIRONMENT,
    resellerId: requireEnv('VIVA_ISV_RESELLER_ID'),
    merchantId: requireEnv('VIVA_ISV_MERCHANT_ID'),
    resellerApiKey: requireEnv('VIVA_ISV_RESELLER_API_KEY'),
  });
}

const [cmd, ...args] = process.argv.slice(2);
const checkoutHost =
  ENVIRONMENT === 'production' ? 'https://www.vivapayments.com' : 'https://demo.vivapayments.com';

async function orders(): Promise<void> {
  const payments = makeIsvPayments();
  for (const label of ['A', 'B', 'C']) {
    const order = await payments.createOrder(
      {
        amount: 1000n,
        currencyCode: asCurrencyCode('826'),
        sourceCode: 'Default',
        merchantTrns: `refund-cap-probe ${label}`,
      },
      {
        merchantId: DEMO_ISV_MERCHANT_ID as MerchantId,
        idempotencyKey: `refund-cap-probe-order-${randomUUID()}`,
      },
    );
    console.log(`${label} orderCode=${order.orderCode} ${checkoutHost}/web/checkout?ref=${order.orderCode}`);
  }
}

type Step = { scenario: string; call: number; query: Record<string, string | number>; status?: number; body?: unknown; error?: string };

function logDir(): string {
  const dir = resolve(import.meta.dirname, '..', 'logs', 'refund-cap-probe', new Date().toISOString().replace(/[:.]/g, '-'));
  mkdirSync(dir, { recursive: true });
  return dir;
}

// One DELETE refund call; records the raw response (or error) into `steps`.
async function del(
  client: ReturnType<typeof makeResellerBasicClient>,
  steps: Step[],
  scenario: string,
  call: number,
  txn: string,
  query: Record<string, string | number>,
): Promise<void> {
    const step: Step = { scenario, call, query };
    try {
      const res = await client.request<unknown>({
        method: 'DELETE',
        path: `/api/transactions/${txn}`,
        query: { sourceCode: 'Default', currencyCode: 826, ...query },
        idempotent: false,
        endpoint: 'DELETE /api/transactions/{transactionId}',
      });
      step.status = (res as { status?: number }).status;
      step.body = res.data;
    } catch (err) {
      step.error = `${String(err)} ${JSON.stringify(err)}`;
    }
    steps.push(step);
    console.log(JSON.stringify(step));
}

async function refund(txnA: string, txnB: string, txnC: string): Promise<void> {
  const client = makeResellerBasicClient();
  const steps: Step[] = [];
  for (const n of [1, 2]) await del(client, steps, 'A full x2', n, txnA, { amount: 1000 });
  for (const n of [1, 2, 3, 4]) await del(client, steps, 'B 300 x4', n, txnB, { amount: 300 });
  const key = `probe-${randomUUID()}`;
  for (const n of [1, 2]) await del(client, steps, 'C 300 same key x2', n, txnC, { amount: 300, idempotencyKey: key });
  await del(client, steps, 'C 300 new key (control)', 3, txnC, { amount: 300, idempotencyKey: `probe-${randomUUID()}` });

  const dir = logDir();
  writeFileSync(resolve(dir, 'results.json'), JSON.stringify({ txnA, txnB, txnC, steps }, null, 2));
  console.log(`results → ${dir}/results.json`);
}

// Order state + its transactions (legacy host, reseller Basic). Debugs a failed checkout.
// `GET /api/transactions?ordercode=` is the merchant API's DEPRECATED listing
// (docs/internal/payment-api.yaml ~8496, "Transactions (Deprecated)"); it is not
// in the ISV spec. Raw responses go to logs/refund-cap-probe/<ts>/status.json.
async function status(orderCodes: string[]): Promise<void> {
  const client = makeResellerBasicClient();
  const out: { orderCode: string; path: string; status?: number; body?: unknown; error?: string }[] = [];
  for (const oc of orderCodes) {
    for (const path of [`/api/orders/${oc}`, `/api/transactions?ordercode=${oc}`]) {
      try {
        const res = await client.request<unknown>({ method: 'GET', path, idempotent: true, endpoint: `GET ${path.split(/[?/]\d/)[0]}` });
        out.push({ orderCode: oc, path, status: (res as { status?: number }).status, body: res.data });
      } catch (err) {
        out.push({ orderCode: oc, path, error: String(err) });
      }
    }
  }
  const json = JSON.stringify(out, (_k, v) => (typeof v === 'bigint' ? String(v) : v), 2);
  const dir = logDir();
  writeFileSync(resolve(dir, 'status.json'), json);
  console.log(`status → ${dir}/status.json`);
}

// One refund on a payment with a given key ('new' = fresh key), then the order's
// listing. For the previous-day probe: an old key re-sent → original refund back
// (key still remembered) or a new refund (key expired).
async function retry(txn: string, amountMinor: string, key: string, orderCode?: string): Promise<void> {
  const client = makeResellerBasicClient();
  const steps: Step[] = [];
  const idempotencyKey = key === 'new' ? `probe-${randomUUID()}` : key;
  await del(client, steps, `retry ${key === 'new' ? 'new key' : 'given key'}`, 1, txn, { amount: Number(amountMinor), idempotencyKey });
  const dir = logDir();
  writeFileSync(resolve(dir, 'retry.json'), JSON.stringify({ txn, amountMinor, idempotencyKey, steps }, null, 2));
  console.log(`retry → ${dir}/retry.json`);
  if (orderCode) await status([orderCode]);
}

// #2 stuck-payment gap: can a retry tell OUR refund from a dashboard refund?
// One refund sending merchantTrns=<key>, then read the refund back on the legacy
// GET /api/transactions/{id} and the v2 (OAuth) retrieve — does merchantTrns echo?
// `control` = an earlier refund id sent WITHOUT merchantTrns, for contrast.
async function trns(txn: string, amountMinor: string, control: string, tagLen?: string, orderCode?: string): Promise<void> {
  const client = makeResellerBasicClient();
  const payments = makeIsvPayments();
  const steps: Step[] = [];
  // tagLen: pad the key to N chars to test a merchantTrns over the 50-char order-create limit.
  const base = `probe-trns-${randomUUID()}`;
  const key = tagLen ? base.padEnd(Number(tagLen), 'x') : base;
  await del(client, steps, 'refund with merchantTrns', 1, txn, { amount: Number(amountMinor), idempotencyKey: key, merchantTrns: key });
  const refundId = (steps[0]?.body as { TransactionId?: string } | undefined)?.TransactionId;
  const reads: { id: string; via: string; body?: unknown; error?: string }[] = [];
  for (const id of [refundId, control].filter((x): x is string => !!x)) {
    try {
      const res = await client.request<unknown>({ method: 'GET', path: `/api/transactions/${id}`, idempotent: true, endpoint: 'GET /api/transactions/{transactionId}' });
      reads.push({ id, via: 'legacy', body: res.data });
    } catch (err) {
      reads.push({ id, via: 'legacy', error: String(err) });
    }
    try {
      const body = await payments.retrieveTransaction(id as never, { merchantId: DEMO_ISV_MERCHANT_ID as MerchantId });
      reads.push({ id, via: 'v2', body });
    } catch (err) {
      reads.push({ id, via: 'v2', error: String(err) });
    }
  }
  const dir = logDir();
  const json = JSON.stringify({ txn, amountMinor, key, steps, reads }, (_k, v) => (typeof v === 'bigint' ? String(v) : v), 2);
  writeFileSync(resolve(dir, 'trns.json'), json);
  for (const r of reads) {
    const b = r.body as Record<string, unknown> | undefined;
    console.log(r.id, r.via, r.error ?? `merchantTrns=${JSON.stringify(b?.['merchantTrns'] ?? b?.['MerchantTrns'] ?? (b?.['Transactions'] as Record<string, unknown>[] | undefined)?.[0]?.['MerchantTrns'])}`);
  }
  console.log(`key=${key} (${key.length} chars)\ntrns → ${dir}/trns.json`);
  if (orderCode) await status([orderCode]);
}

if (cmd === 'orders') await orders();
else if (cmd === 'trns' && args.length >= 3) await trns(args[0]!, args[1]!, args[2]!, args[3], args[4]);
else if (cmd === 'retry' && (args.length === 3 || args.length === 4)) await retry(args[0]!, args[1]!, args[2]!, args[3]);
else if (cmd === 'status' && args.length > 0) await status(args);
else if (cmd === 'refund' && args.length === 3) await refund(args[0]!, args[1]!, args[2]!);
else {
  console.error('usage: orders | status <orderCode...> | refund <txnA> <txnB> <txnC> | retry <txnId> <amountMinor> <key|new> [orderCode]');
  process.exit(1);
}
