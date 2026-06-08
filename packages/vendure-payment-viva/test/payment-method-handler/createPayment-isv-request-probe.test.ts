/**
 * test/payment-method-handler/createPayment-isv-request-probe.test.ts
 *
 * PROBE — captures the exact Viva `createOrder` request that
 * `vivaPaymentMethodHandler.createPayment` emits, by spying on the
 * `isvPayments.createOrder` seam injected via `_testInjectDeps`.
 *
 * This is the HANDLER-layer seam: it captures what the handler passes *to* the
 * Payments adapter (pre-strip). The mode-aware wire-body stripping (isvAmount
 * dropped in merchant mode, currencyCode → Number) happens INSIDE the real
 * `Payments.createOrder`, which a `vi.fn()` mock bypasses. For the post-strip
 * HTTP wire body see createPayment.test.ts (#7 transmission tests).
 *
 * Inputs mirror the live demo connected merchant (scripts/viva-create-order-findings.md):
 *   merchantId 5cf789ee-6b1b-46ab-a71f-03ffdb912c9a, GBP order, 99p ISV fee.
 *
 * No network, no DB, no Vendure boot — pure function call through the DI seam.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Logger } from '@vendure/core';
import { vivaPaymentMethodHandler, _testInjectDeps } from '../../src/payment-method-handler.js';
import { VivaPluginError } from '../../src/util/error-envelope.js';

// ---------------------------------------------------------------------------
// Fixtures — the live demo connected merchant + a GBP order with a 99p fee
// ---------------------------------------------------------------------------

const DEMO_MERCHANT_ID = '5cf789ee-6b1b-46ab-a71f-03ffdb912c9a';
const ISV_FEE_MINOR = 99; // 99p surcharge
const ORDER_AMOUNT_MINOR = 1399; // £13.99 totalWithTax

function makeCtx() {
  return {
    channelId: 1,
    channel: {
      id: 1,
      code: 'default',
      customFields: {
        vivaMerchantId: DEMO_MERCHANT_ID,
        vivaSourceCode: '', // empty → handler falls back to 'Default'
        vivaPayoutsEnabled: true,
      },
    },
    apiType: 'shop',
  } as any;
}

function makeOrder() {
  return {
    id: 13,
    code: 'ORDER-013',
    totalWithTax: ORDER_AMOUNT_MINOR,
    currencyCode: 'GBP',
    state: 'ArrangingPayment',
  } as any;
}

/** Minimal ISV options — only the fields createPayment reads. */
function makeOptions(overrides: Record<string, unknown> = {}) {
  return {
    mode: 'isv',
    environment: 'demo',
    resolveIsvAmount: () => ISV_FEE_MINOR,
    successUrl: () => 'https://store.example/checkout/success?ref={orderCode}',
    failureUrl: () => 'https://store.example/checkout/failure',
    ...overrides,
  } as any;
}

/**
 * Inject deps with a spy `createOrder`. The returned `createOrder` mock is the
 * seam: its first call argument is the exact request the handler produced.
 */
function injectWith(createOrder: ReturnType<typeof vi.fn>, optionOverrides = {}) {
  const setOrderCode = vi.fn().mockResolvedValue(undefined);
  const upsertPendingTransaction = vi.fn().mockResolvedValue({
    row: { id: 'row-1', vivaOrderCode: null, metadata: {} },
    wasInserted: true,
  });
  _testInjectDeps({
    options: makeOptions(optionOverrides),
    oauth2: {} as any,
    stateMachine: { upsertPendingTransaction, setOrderCode } as any,
    isvPayments: { createOrder } as any,
  });
  return { setOrderCode, upsertPendingTransaction };
}

const call = (ctx: any, order: any, amount: number) =>
  (vivaPaymentMethodHandler as any).createPaymentFn(ctx, order, amount, {}, {});

// ---------------------------------------------------------------------------

beforeEach(() => {
  vi.spyOn(Logger, 'info').mockReturnValue(undefined);
  vi.spyOn(Logger, 'warn').mockReturnValue(undefined);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('PROBE: createPayment → Viva createOrder request (ISV)', () => {
  it('emits amount, currencyCode 826, Default source, and the 99p isvAmount', async () => {
    const createOrder = vi.fn().mockResolvedValue({ orderCode: 3144322017902375n });
    injectWith(createOrder);

    const result = await call(makeCtx(), makeOrder(), ORDER_AMOUNT_MINOR);

    // Inspect the captured request (this is the exact handler→adapter call).
    const [body, opts] = createOrder.mock.calls[0];
    // eslint-disable-next-line no-console
    console.log('[probe] createOrder body =', body, '\n[probe] createOrder opts =', opts);

    // Body: bigint amount, numeric-as-string currency (Number cast happens in
    // the real adapter), Default source, and the platform fee as a bigint.
    expect(body).toEqual({
      amount: BigInt(ORDER_AMOUNT_MINOR),
      currencyCode: '826',
      sourceCode: 'Default',
      isvAmount: BigInt(ISV_FEE_MINOR),
    });

    // Opts: stable idempotency key + the connected merchant id.
    expect(opts).toEqual({
      idempotencyKey: `viva:1:13:${ORDER_AMOUNT_MINOR}:GBP`,
      merchantId: DEMO_MERCHANT_ID,
    });

    // And the handler returns a usable redirect for the captured orderCode.
    expect(result.state).toBe('Created');
    expect(result.metadata.vivaOrderCode).toBe('3144322017902375');
    expect(result.metadata.redirectUrl).toContain('demo.vivapayments.com/web/checkout?ref=3144322017902375');
  });

  it('omits isvAmount entirely when the resolved fee is 0 (avoids Viva minimum=30)', async () => {
    const createOrder = vi.fn().mockResolvedValue({ orderCode: 999n });
    injectWith(createOrder, { resolveIsvAmount: () => 0 });

    await call(makeCtx(), makeOrder(), ORDER_AMOUNT_MINOR);

    const [body] = createOrder.mock.calls[0];
    expect(body).not.toHaveProperty('isvAmount');
  });

  it('empty {} response (no orderCode) → VIVA_API_ERROR, not a TypeError crash', async () => {
    const createOrder = vi.fn().mockResolvedValue({}); // the original #8 repro
    injectWith(createOrder);
    const errorSpy = vi.spyOn(Logger, 'error').mockReturnValue(undefined);

    const err = await call(makeCtx(), makeOrder(), ORDER_AMOUNT_MINOR).catch((e: any) => e);

    expect(err).toBeInstanceOf(VivaPluginError);
    expect(err).not.toBeInstanceOf(TypeError);
    expect(err.code).toBe('VIVA_API_ERROR');
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('no orderCode'), expect.any(String));
  });
});
