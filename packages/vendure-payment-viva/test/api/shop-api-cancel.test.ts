/**
 * test/api/shop-api-cancel.test.ts — VivaShopApiResolver.cancelPayment tests.
 *
 * Uses a minimal Nest test module (no full Vendure bootstrap).
 * Mocks: OrderService, PaymentService (incl. cancelPayment), TransactionalConnection,
 *        StateMachineService.
 *
 * NOTE (#12): the resolver cancels via PaymentService.cancelPayment — which
 * transitions the Vendure Payment Created→Cancelled (so a retry sees the full
 * outstanding amount) AND voids Viva through our handler — rather than calling
 * the handler fn directly (which left the Payment in Created and blocked retry).
 *
 * Covers:
 *  - Happy path: customer-owned order, Authorized payment → returns Order
 *  - Anonymous order happy path: no activeUserId, session activeOrderId matches
 *  - Wrong customer: returns CancelPaymentError AUTHORIZATION_FAILED
 *  - Anonymous order, wrong session: returns AUTHORIZATION_FAILED
 *  - Payment not found: returns VIVA_PAYMENT_NOT_CANCELLABLE
 *  - viva_transaction row missing: returns VIVA_PAYMENT_NOT_CANCELLABLE
 *  - Already-terminal status: returns VIVA_PAYMENT_NOT_CANCELLABLE
 *  - Viva 4xx: returns CancelPaymentError VIVA_API_ERROR + vivaErrorCode + vivaErrorMessage
 *  - Viva 5xx: returns CancelPaymentError VIVA_AUTH_DOWN
 *  - Idempotent re-call: already-AddingItems order → still returns Order
 *
 * @see docs/plans/vendure-plugin-v0.md §"Build Plan — V8"
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { VivaShopApiResolver } from '../../src/api/shop-api.resolver.js';
import { VivaPluginError } from '../../src/util/error-envelope.js';

// ---------------------------------------------------------------------------
// Helpers — fake RequestContext
// ---------------------------------------------------------------------------

function makeCtx(opts: {
  activeUserId?: string | number | null;
  sessionActiveOrderId?: string | number | null;
  channelId?: number;
} = {}): any {
  return {
    activeUserId: opts.activeUserId ?? null,
    channelId: opts.channelId ?? 1,
    session: {
      user: opts.activeUserId ? { id: opts.activeUserId } : undefined,
      activeOrderId: opts.sessionActiveOrderId ?? null,
    },
  };
}

// ---------------------------------------------------------------------------
// Helpers — fake Order
// ---------------------------------------------------------------------------

function makeOrder(opts: {
  id?: number;
  state?: string;
  customerId?: number | null;
  customerUserId?: number | null;
} = {}): any {
  return {
    id: opts.id ?? 100,
    code: 'ORDER-001',
    state: opts.state ?? 'ArrangingPayment',
    customer: opts.customerUserId !== undefined && opts.customerUserId !== null
      ? { id: opts.customerId ?? 10, user: { id: opts.customerUserId } }
      : opts.customerId !== undefined && opts.customerId !== null
        ? { id: opts.customerId, user: null }
        : null,
  };
}

// ---------------------------------------------------------------------------
// Helpers — fake Payment
// ---------------------------------------------------------------------------

function makePayment(opts: {
  id?: number;
  orderId?: number;
  state?: string;
  metadata?: Record<string, unknown>;
} = {}): any {
  return {
    id: opts.id ?? 99,
    amount: 2000,
    state: opts.state ?? 'Created',
    metadata: opts.metadata ?? {},
    order: { id: opts.orderId ?? 100 },
  };
}

// ---------------------------------------------------------------------------
// Helpers — fake VivaTransaction row
// ---------------------------------------------------------------------------

function makeVivaRow(opts: {
  id?: string;
  vivaOrderCode?: string | null;
  status?: string;
} = {}): any {
  return {
    id: opts.id ?? 'row-1',
    channelId: 1,
    paymentId: 99,
    vivaOrderCode: opts.vivaOrderCode ?? '123456789012',
    vivaTransactionId: null,
    status: opts.status ?? 'pending',
    amountMinor: '2000',
    currencyCode: 'GBP',
    isvAmountMinor: '0',
    metadata: { vivaMerchantId: 'merchant-uuid-1234' },
    createdAt: new Date(),
    updatedAt: new Date(),
  };
}

// ---------------------------------------------------------------------------
// Mock services factory
// ---------------------------------------------------------------------------

interface ResolverDeps {
  orderService: any;
  paymentService: any;
  connection: any;
  stateMachine: any;
  options: any;
}

function buildDeps(overrides: Partial<{
  payment: any;
  order: any;
  activeOrder: any;
  vivaRow: any;
  cancelPaymentFnResult: 'ok' | Error;
  transitionToStateResult: 'ok' | Error;
  findOneOrder2?: any;
}> = {}): ResolverDeps {
  const {
    payment = makePayment(),
    order = makeOrder({ customerUserId: 42 }),
    activeOrder = null,
    vivaRow = makeVivaRow(),
    cancelPaymentFnResult = 'ok',
    transitionToStateResult = 'ok',
    findOneOrder2,
  } = overrides;

  // Track how many times findOne is called so we can return different orders
  let findOneCallCount = 0;

  const orderService = {
    findOne: vi.fn().mockImplementation(async () => {
      findOneCallCount++;
      if (findOneCallCount === 1) return order;
      if (findOneOrder2 !== undefined) return findOneOrder2;
      return order;
    }),
    getActiveOrderForUser: vi.fn().mockResolvedValue(activeOrder),
    transitionToState: vi.fn().mockImplementation(async () => {
      if (transitionToStateResult instanceof Error) throw transitionToStateResult;
      return order;
    }),
  };

  const paymentService = {
    findOneOrThrow: payment
      ? vi.fn().mockResolvedValue(payment)
      : vi.fn().mockRejectedValue(new Error('not found')),
    // The resolver now cancels via PaymentService.cancelPayment, which both
    // voids Viva (through our handler) AND transitions the Payment to
    // 'Cancelled'. On a Viva failure our handler throws VivaPluginError, which
    // core propagates — modelled here by rejecting with `cancelPaymentFnResult`.
    cancelPayment: vi.fn().mockImplementation(async () => {
      if (cancelPaymentFnResult instanceof Error) throw cancelPaymentFnResult;
      return { ...(payment ?? {}), state: 'Cancelled' };
    }),
  };

  const stateMachine = {
    getVivaTransaction: vi.fn().mockResolvedValue(vivaRow),
  };

  const connection = {};

  const options = {
    mode: 'isv' as const,

    clientId: 'test-id',
    clientSecret: 'test-secret',
    onboardingReturnUrl: 'https://example.com/onboarding-return',
    environment: 'demo',
    webhookVerificationKey: 'key',
    legacyMerchantId: 'test-legacy-merchant-uuid',
    legacyApiKey: 'test-legacy-api-key',
    successUrl: 'https://example.com/success',
    failureUrl: 'https://example.com/failure',
  };

  return { orderService, paymentService, connection, stateMachine, options };
}

function buildResolver(deps: ResolverDeps): VivaShopApiResolver {
  return new VivaShopApiResolver(
    deps.orderService,
    deps.paymentService,
    deps.connection as any,
    deps.stateMachine as any,
    deps.options,
  );
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('VivaShopApiResolver.cancelPayment', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  // -------------------------------------------------------------------------
  // Happy path — authenticated customer
  // -------------------------------------------------------------------------

  it('happy path: customer-owned order → returns Order', async () => {
    const order = makeOrder({ id: 100, customerUserId: 42, state: 'ArrangingPayment' });
    const payment = makePayment({ id: 99, orderId: 100 });
    const ctx = makeCtx({ activeUserId: 42 });

    // First findOne returns order (with customer.user), second also returns it
    const deps = buildDeps({ payment, order, vivaRow: makeVivaRow() });
    const resolver = buildResolver(deps);

    const result = await resolver.cancelPayment('99', ctx) as any;

    expect(result.__typename).toBe('Order');
    expect(result.id).toBe(100);
    expect(deps.orderService.transitionToState).toHaveBeenCalledWith(
      ctx,
      100,
      'AddingItems',
    );
    // The cancel is delegated to PaymentService.cancelPayment (which transitions
    // the Payment → Cancelled AND voids Viva via our handler) — issue #12.
    expect(deps.paymentService.cancelPayment).toHaveBeenCalledOnce();
    expect(deps.paymentService.cancelPayment).toHaveBeenCalledWith(ctx, payment.id);
  });

  // -------------------------------------------------------------------------
  // Happy path — anonymous order (session activeOrderId matches)
  // -------------------------------------------------------------------------

  it('anonymous order happy path: session activeOrderId matches → returns Order', async () => {
    const order = makeOrder({ id: 200, customerUserId: null, customerId: null, state: 'ArrangingPayment' });
    const payment = makePayment({ id: 88, orderId: 200 });
    // ctx has no activeUserId, but session.activeOrderId = 200
    const ctx = makeCtx({ activeUserId: null, sessionActiveOrderId: 200 });

    const deps = buildDeps({ payment, order, vivaRow: makeVivaRow({ id: 'row-2' }) });
    const resolver = buildResolver(deps);

    const result = await resolver.cancelPayment('88', ctx) as any;

    expect(result.__typename).toBe('Order');
    expect(result.id).toBe(200);
  });

  // -------------------------------------------------------------------------
  // Wrong customer — returns AUTHORIZATION_FAILED
  // -------------------------------------------------------------------------

  it('wrong customer: returns CancelPaymentError AUTHORIZATION_FAILED', async () => {
    const order = makeOrder({ id: 100, customerUserId: 42 });
    const payment = makePayment({ id: 99, orderId: 100 });
    // ctx.activeUserId = 99 (different user), no session match
    const ctx = makeCtx({ activeUserId: 99, sessionActiveOrderId: null });

    const deps = buildDeps({ payment, order, activeOrder: null });
    const resolver = buildResolver(deps);

    const result = await resolver.cancelPayment('99', ctx) as any;

    expect(result.__typename).toBe('CancelPaymentError');
    expect(result.errorCode).toBe('AUTHORIZATION_FAILED');
    expect(result.message).toContain('only cancel your own');
    expect(deps.paymentService.cancelPayment).not.toHaveBeenCalled();
  });

  // -------------------------------------------------------------------------
  // Anonymous order, wrong session — returns AUTHORIZATION_FAILED
  // -------------------------------------------------------------------------

  it('anonymous order, wrong session: returns AUTHORIZATION_FAILED', async () => {
    const order = makeOrder({ id: 100, customerUserId: null, customerId: null });
    const payment = makePayment({ id: 99, orderId: 100 });
    // Session activeOrderId = 999 (different order)
    const ctx = makeCtx({ activeUserId: null, sessionActiveOrderId: 999 });

    const deps = buildDeps({ payment, order, activeOrder: null });
    const resolver = buildResolver(deps);

    const result = await resolver.cancelPayment('99', ctx) as any;

    expect(result.__typename).toBe('CancelPaymentError');
    expect(result.errorCode).toBe('AUTHORIZATION_FAILED');
  });

  // -------------------------------------------------------------------------
  // Payment not found
  // -------------------------------------------------------------------------

  it('payment not found: returns VIVA_PAYMENT_NOT_CANCELLABLE', async () => {
    const ctx = makeCtx({ activeUserId: 42 });

    // paymentService.findOneOrThrow throws
    const deps = buildDeps({ payment: null as any });
    // Override the mock to throw
    deps.paymentService.findOneOrThrow = vi.fn().mockRejectedValue(new Error('not found'));
    const resolver = buildResolver(deps);

    const result = await resolver.cancelPayment('999', ctx) as any;

    expect(result.__typename).toBe('CancelPaymentError');
    expect(result.errorCode).toBe('VIVA_PAYMENT_NOT_CANCELLABLE');
    expect(result.message).toContain('not found');
  });

  // -------------------------------------------------------------------------
  // viva_transaction row missing
  // -------------------------------------------------------------------------

  it('viva_transaction row missing: returns VIVA_PAYMENT_NOT_CANCELLABLE', async () => {
    const order = makeOrder({ id: 100, customerUserId: 42 });
    const payment = makePayment({ id: 99, orderId: 100 });
    const ctx = makeCtx({ activeUserId: 42 });

    const deps = buildDeps({ payment, order, vivaRow: null as any });
    deps.stateMachine.getVivaTransaction = vi.fn().mockResolvedValue(null);
    const resolver = buildResolver(deps);

    const result = await resolver.cancelPayment('99', ctx) as any;

    expect(result.__typename).toBe('CancelPaymentError');
    expect(result.errorCode).toBe('VIVA_PAYMENT_NOT_CANCELLABLE');
    expect(deps.paymentService.cancelPayment).not.toHaveBeenCalled();
  });

  it('#33: row missing but payment metadata carries vivaOrderCode → proceeds to cancel (no short-circuit)', async () => {
    const order = makeOrder({ id: 100, customerUserId: 42 });
    const payment = makePayment({
      id: 99,
      orderId: 100,
      metadata: { vivaOrderCode: '123456789012', vivaMerchantId: 'merchant-uuid-1234' },
    });
    const ctx = makeCtx({ activeUserId: 42 });

    const deps = buildDeps({ payment, order, vivaRow: null as any });
    deps.stateMachine.getVivaTransaction = vi.fn().mockResolvedValue(null);
    const resolver = buildResolver(deps);

    const result = await resolver.cancelPayment('99', ctx) as any;

    // The pre-guard must NOT short-circuit — the payment is legitimately
    // initiated (orderCode in metadata), so the cancel must reach the handler.
    expect(deps.paymentService.cancelPayment).toHaveBeenCalledWith(ctx, 99);
    expect(result.__typename).not.toBe('CancelPaymentError');
  });

  // -------------------------------------------------------------------------
  // Already-terminal status
  // -------------------------------------------------------------------------

  it('already-terminal status (cancelled): returns VIVA_PAYMENT_NOT_CANCELLABLE', async () => {
    const order = makeOrder({ id: 100, customerUserId: 42 });
    const payment = makePayment({ id: 99, orderId: 100 });
    const ctx = makeCtx({ activeUserId: 42 });

    const deps = buildDeps({
      payment,
      order,
      vivaRow: makeVivaRow({ status: 'cancelled' }),
    });
    const resolver = buildResolver(deps);

    const result = await resolver.cancelPayment('99', ctx) as any;

    expect(result.__typename).toBe('CancelPaymentError');
    expect(result.errorCode).toBe('VIVA_PAYMENT_NOT_CANCELLABLE');
    expect(result.message).toContain('cancelled');
    expect(deps.paymentService.cancelPayment).not.toHaveBeenCalled();
  });

  it('already-terminal status (captured): returns VIVA_PAYMENT_NOT_CANCELLABLE', async () => {
    const order = makeOrder({ id: 100, customerUserId: 42 });
    const payment = makePayment({ id: 99, orderId: 100 });
    const ctx = makeCtx({ activeUserId: 42 });

    const deps = buildDeps({
      payment,
      order,
      vivaRow: makeVivaRow({ status: 'captured' }),
    });
    const resolver = buildResolver(deps);

    const result = await resolver.cancelPayment('99', ctx) as any;

    expect(result.__typename).toBe('CancelPaymentError');
    expect(result.errorCode).toBe('VIVA_PAYMENT_NOT_CANCELLABLE');
  });

  // -------------------------------------------------------------------------
  // Viva 4xx — VIVA_API_ERROR with passthrough fields
  // -------------------------------------------------------------------------

  it('Viva 4xx: returns CancelPaymentError VIVA_API_ERROR + vivaErrorCode + vivaErrorMessage', async () => {
    const order = makeOrder({ id: 100, customerUserId: 42 });
    const payment = makePayment({ id: 99, orderId: 100 });
    const ctx = makeCtx({ activeUserId: 42 });

    const vivaErr = VivaPluginError.apiError({
      message: 'Order already cancelled',
      vivaErrorCode: 404,
      vivaErrorMessage: 'Order not found',
    });

    const deps = buildDeps({
      payment,
      order,
      vivaRow: makeVivaRow(),
      cancelPaymentFnResult: vivaErr,
    });
    const resolver = buildResolver(deps);

    const result = await resolver.cancelPayment('99', ctx) as any;

    expect(result.__typename).toBe('CancelPaymentError');
    expect(result.errorCode).toBe('VIVA_API_ERROR');
    expect(result.vivaErrorCode).toBe(404);
    expect(result.vivaErrorMessage).toBe('Order not found');
  });

  // -------------------------------------------------------------------------
  // Viva 5xx — VIVA_AUTH_DOWN
  // -------------------------------------------------------------------------

  it('Viva 5xx: returns CancelPaymentError VIVA_AUTH_DOWN', async () => {
    const order = makeOrder({ id: 100, customerUserId: 42 });
    const payment = makePayment({ id: 99, orderId: 100 });
    const ctx = makeCtx({ activeUserId: 42 });

    const vivaErr = VivaPluginError.authDown('Viva API unavailable');

    const deps = buildDeps({
      payment,
      order,
      vivaRow: makeVivaRow(),
      cancelPaymentFnResult: vivaErr,
    });
    const resolver = buildResolver(deps);

    const result = await resolver.cancelPayment('99', ctx) as any;

    expect(result.__typename).toBe('CancelPaymentError');
    expect(result.errorCode).toBe('VIVA_AUTH_DOWN');
  });

  // -------------------------------------------------------------------------
  // Idempotent re-call: order already in AddingItems → still returns Order
  // -------------------------------------------------------------------------

  it('idempotent re-call: order already AddingItems → returns Order (no error)', async () => {
    // Order is already AddingItems (swept back before this call)
    const order = makeOrder({ id: 100, customerUserId: 42, state: 'AddingItems' });
    const payment = makePayment({ id: 99, orderId: 100 });
    const ctx = makeCtx({ activeUserId: 42 });

    const deps = buildDeps({ payment, order, vivaRow: makeVivaRow() });
    const resolver = buildResolver(deps);

    const result = await resolver.cancelPayment('99', ctx) as any;

    // cancel still delegated (Viva void + Payment→Cancelled) even on re-call
    expect(deps.paymentService.cancelPayment).toHaveBeenCalledOnce();
    // transitionToState NOT called (already AddingItems)
    expect(deps.orderService.transitionToState).not.toHaveBeenCalled();
    expect(result.__typename).toBe('Order');
  });
});
