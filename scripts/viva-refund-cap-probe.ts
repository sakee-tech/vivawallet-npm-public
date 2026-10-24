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

async function refund(txnA: string, txnB: string, txnC: string): Promise<void> {
  const client = makeResellerBasicClient();
  const steps: Step[] = [];

  async function del(scenario: string, call: number, txn: string, query: Record<string, string | number>): Promise<void> {
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

  for (const n of [1, 2]) await del('A full x2', n, txnA, { amount: 1000 });
  for (const n of [1, 2, 3, 4]) await del('B 300 x4', n, txnB, { amount: 300 });
  const key = `probe-${randomUUID()}`;
  for (const n of [1, 2]) await del('C 300 same key x2', n, txnC, { amount: 300, idempotencyKey: key });
  await del('C 300 new key (control)', 3, txnC, { amount: 300, idempotencyKey: `probe-${randomUUID()}` });

  const dir = resolve(import.meta.dirname, '..', 'logs', 'refund-cap-probe', new Date().toISOString().replace(/[:.]/g, '-'));
  mkdirSync(dir, { recursive: true });
  writeFileSync(resolve(dir, 'results.json'), JSON.stringify({ txnA, txnB, txnC, steps }, null, 2));
  console.log(`results → ${dir}/results.json`);
}

// Order state + its transactions (legacy host, reseller Basic). Debugs a failed checkout.
async function status(orderCodes: string[]): Promise<void> {
  const client = makeResellerBasicClient();
  for (const oc of orderCodes) {
    for (const path of [`/api/orders/${oc}`, `/api/transactions?ordercode=${oc}`]) {
      try {
        const res = await client.request<unknown>({ method: 'GET', path, idempotent: true, endpoint: `GET ${path.split(/[?/]\d/)[0]}` });
        console.log(oc, path, JSON.stringify(res.data, (_k, v) => (typeof v === 'bigint' ? String(v) : v)));
      } catch (err) {
        console.log(oc, path, 'ERROR', String(err));
      }
    }
  }
}

if (cmd === 'orders') await orders();
else if (cmd === 'status' && args.length > 0) await status(args);
else if (cmd === 'refund' && args.length === 3) await refund(args[0]!, args[1]!, args[2]!);
else {
  console.error('usage: orders | refund <txnA> <txnB> <txnC>');
  process.exit(1);
}
