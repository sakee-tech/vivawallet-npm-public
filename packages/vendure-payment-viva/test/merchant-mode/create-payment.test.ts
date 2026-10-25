/**
 * test/merchant-mode/create-payment.test.ts
 *
 * Slice B — merchant-mode createPayment behaviour.
 * Verifies: URL contract (no /isv segment, no merchantId query), wire body
 * (no isvAmount), source-code resolution (config + channel override), and
 * row metadata captured the configured legacyMerchantId.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { MockAgent } from 'undici';
import { Logger } from '@vendure/core';
import { vivaPaymentMethodHandler, _testInjectDeps } from '../../src/payment-method-handler.js';
import {
  makeMerchantOptions,
  makeCtx,
  makeOrder,
  buildOAuth2Strategy,
  seedToken,
  buildMerchantPayments,
  makeMockStateMachine,
  DEMO_API_HOST,
} from './helpers.js';

let agent: MockAgent;

beforeEach(() => {
  agent = new MockAgent();
  agent.disableNetConnect();
  vi.spyOn(Logger, 'info').mockReturnValue(undefined);
  vi.spyOn(Logger, 'warn').mockReturnValue(undefined);
});

afterEach(async () => {
  await agent.close();
  vi.restoreAllMocks();
});

function setupHandler(overrides: Parameters<typeof makeMerchantOptions>[0] = {}) {
  const options = makeMerchantOptions(overrides);
  const strategy = buildOAuth2Strategy(agent);
  const { isvPayments } = buildMerchantPayments(agent, strategy, options);
  const stateMachine = makeMockStateMachine();
  _testInjectDeps({ options, oauth2: strategy, stateMachine: stateMachine as any, isvPayments });
  return { options, strategy, stateMachine, isvPayments };
}

describe('merchant-mode createPayment — URL contract', () => {
  it('POSTs to /checkout/v2/orders WITHOUT /isv and WITHOUT ?merchantId=', async () => {
    const { strategy } = setupHandler();
    await seedToken(strategy);

    let capturedPath: string | undefined;
    agent
      .get(DEMO_API_HOST)
      .intercept({ path: /\/checkout\/v2\//, method: 'POST' })
      .reply(200, (opts: any) => {
        capturedPath = opts.path as string;
        return { OrderCode: 1234567890 };
      }, { headers: { 'content-type': 'application/json' } });

    const ctx = makeCtx();
    const order = makeOrder({ currencyCode: 'EUR' });
    const result = await (vivaPaymentMethodHandler as any).createPaymentFn(ctx, order, 2000, {}, {});

    expect(result.state).toBe('Created');
    expect(capturedPath).toBeDefined();
    expect(capturedPath!).toContain('/checkout/v2/orders');
    expect(capturedPath!).not.toContain('/isv/');
    expect(capturedPath!).not.toContain('merchantId=');
  });

  it('wire body strips isvAmount in merchant mode', async () => {
    const { strategy } = setupHandler();
    await seedToken(strategy);

    let capturedBody: string | undefined;
    agent
      .get(DEMO_API_HOST)
      .intercept({ path: /\/checkout\/v2\//, method: 'POST' })
      .reply(200, (opts: any) => {
        capturedBody = typeof opts.body === 'string' ? opts.body : Buffer.from(opts.body ?? '').toString();
        return { OrderCode: 1234567890 };
      }, { headers: { 'content-type': 'application/json' } });

    const ctx = makeCtx();
    const order = makeOrder({ currencyCode: 'EUR' });
    await (vivaPaymentMethodHandler as any).createPaymentFn(ctx, order, 2000, {}, {});

    expect(capturedBody).toBeDefined();
    expect(capturedBody!).not.toContain('isvAmount');
  });

  it('returns Created state + demo redirectUrl', async () => {
    const { strategy } = setupHandler();
    await seedToken(strategy);

    agent
      .get(DEMO_API_HOST)
      .intercept({ path: /\/checkout\/v2\//, method: 'POST' })
      .reply(200, { OrderCode: 555 }, { headers: { 'content-type': 'application/json' } });

    const ctx = makeCtx();
    const order = makeOrder();
    const result = await (vivaPaymentMethodHandler as any).createPaymentFn(ctx, order, 2000, {}, {});

    expect(result.state).toBe('Created');
    expect(result.amount).toBe(2000);
    expect(result.metadata['redirectUrl']).toContain('demo.vivapayments.com');
    expect(result.metadata['redirectUrl']).toContain('555');
    expect(result.metadata['vivaOrderCode']).toBe('555');
    // Row metadata captures the configured legacyMerchantId — not the
    // ignored channel custom field.
    expect(result.metadata['vivaMerchantId']).toBe('test-legacy-merchant-uuid');
  });
});

describe('merchant-mode createPayment — sourceCode', () => {
  it('config.sourceCode → emitted in wire body', async () => {
    const { strategy } = setupHandler({ sourceCode: 'MyCustomSource' });
    await seedToken(strategy);

    let capturedBody: string | undefined;
    agent
      .get(DEMO_API_HOST)
      .intercept({ path: /\/checkout\/v2\//, method: 'POST' })
      .reply(200, (opts: any) => {
        capturedBody = typeof opts.body === 'string' ? opts.body : Buffer.from(opts.body ?? '').toString();
        return { OrderCode: 777 };
      }, { headers: { 'content-type': 'application/json' } });

    const ctx = makeCtx();
    const order = makeOrder();
    await (vivaPaymentMethodHandler as any).createPaymentFn(ctx, order, 1000, {}, {});

    expect(capturedBody).toBeDefined();
    expect(capturedBody!).toContain('"sourceCode":"MyCustomSource"');
  });

  it('channel custom field vivaSourceCode overrides config.sourceCode', async () => {
    const { strategy } = setupHandler({ sourceCode: 'ConfigSource' });
    await seedToken(strategy);

    let capturedBody: string | undefined;
    agent
      .get(DEMO_API_HOST)
      .intercept({ path: /\/checkout\/v2\//, method: 'POST' })
      .reply(200, (opts: any) => {
        capturedBody = typeof opts.body === 'string' ? opts.body : Buffer.from(opts.body ?? '').toString();
        return { OrderCode: 888 };
      }, { headers: { 'content-type': 'application/json' } });

    const ctx = makeCtx({ vivaSourceCode: 'ChannelOverride' });
    const order = makeOrder();
    await (vivaPaymentMethodHandler as any).createPaymentFn(ctx, order, 1000, {}, {});

    expect(capturedBody).toBeDefined();
    expect(capturedBody!).toContain('"sourceCode":"ChannelOverride"');
  });

  it('no config.sourceCode and no channel override → defaults to "Default"', async () => {
    const { strategy } = setupHandler();
    await seedToken(strategy);

    let capturedBody: string | undefined;
    agent
      .get(DEMO_API_HOST)
      .intercept({ path: /\/checkout\/v2\//, method: 'POST' })
      .reply(200, (opts: any) => {
        capturedBody = typeof opts.body === 'string' ? opts.body : Buffer.from(opts.body ?? '').toString();
        return { OrderCode: 999 };
      }, { headers: { 'content-type': 'application/json' } });

    const ctx = makeCtx(); // no vivaSourceCode override
    const order = makeOrder();
    await (vivaPaymentMethodHandler as any).createPaymentFn(ctx, order, 1000, {}, {});

    expect(capturedBody).toBeDefined();
    expect(capturedBody!).toContain('"sourceCode":"Default"');
  });
});

describe('merchant-mode createPayment — ISV guards do not fire', () => {
  it('vivaPayoutsEnabled=false channel field is IGNORED in merchant mode', async () => {
    // ctx has vivaPayoutsEnabled: false by default; ISV mode would throw
    // VIVA_ACCOUNT_NOT_VERIFIED. Merchant mode must succeed.
    const { strategy } = setupHandler();
    await seedToken(strategy);

    agent
      .get(DEMO_API_HOST)
      .intercept({ path: /\/checkout\/v2\//, method: 'POST' })
      .reply(200, { OrderCode: 1111 }, { headers: { 'content-type': 'application/json' } });

    const ctx = makeCtx(); // helper seeds vivaPayoutsEnabled=false
    const order = makeOrder();
    const result = await (vivaPaymentMethodHandler as any).createPaymentFn(ctx, order, 1000, {}, {});

    expect(result.state).toBe('Created');
  });
});
