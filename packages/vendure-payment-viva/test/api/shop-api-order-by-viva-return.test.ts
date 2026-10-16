/**
 * test/api/shop-api-order-by-viva-return.test.ts
 * VivaShopApiResolver.orderByVivaReturn tests.
 *
 * Resolves a Smart Checkout return (?s=<vivaOrderCode>) to its Vendure Order via
 * the plugin's own viva_transaction table — no ISV API call (#28). Owner-scoped
 * exactly like cancelPayment: returns null (never an error) when the code is
 * unknown OR not owned by the caller, so `?s=` can't be enumerated to leak orders.
 *
 * Covers:
 *  - Happy path: customer-owned order → returns Order
 *  - Anonymous order happy path: session activeOrderId matches → returns Order
 *  - Unknown vivaOrderCode (no row) → null
 *  - Row without paymentId → null
 *  - Payment not found → null
 *  - Wrong customer → null (NOT an error — no enumeration signal)
 *  - Anonymous order, wrong session → null
 *  - Empty vivaOrderCode arg → null (no lookup)
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import { VivaShopApiResolver } from '../../src/api/shop-api.resolver.js';

// ---------------------------------------------------------------------------
// Helpers (mirror shop-api-cancel.test.ts)
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

function makeOrder(opts: {
  id?: number;
  state?: string;
  customerId?: number | null;
  customerUserId?: number | null;
} = {}): any {
  return {
    id: opts.id ?? 100,
    code: 'ORDER-001',
    state: opts.state ?? 'PaymentSettled',
    customer:
      opts.customerUserId !== undefined && opts.customerUserId !== null
        ? { id: opts.customerId ?? 10, user: { id: opts.customerUserId } }
        : null,
  };
}

function makePayment(opts: { id?: number; orderId?: number } = {}): any {
  return {
    id: opts.id ?? 99,
    state: 'Settled',
    metadata: {},
    order: { id: opts.orderId ?? 100 },
  };
}

function makeVivaRow(opts: { vivaOrderCode?: string | null; paymentId?: number | null } = {}): any {
  return {
    id: 'row-1',
    channelId: 1,
    paymentId: opts.paymentId === undefined ? 99 : opts.paymentId,
    vivaOrderCode: opts.vivaOrderCode ?? '123456789012',
    status: 'pending',
  };
}

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
}> = {}): ResolverDeps {
  const {
    payment = makePayment(),
    order = makeOrder({ customerUserId: 42 }),
    activeOrder = null,
    vivaRow = makeVivaRow(),
  } = overrides;

  const orderService = {
    findOne: vi.fn().mockResolvedValue(order),
    getActiveOrderForUser: vi.fn().mockResolvedValue(activeOrder),
    transitionToState: vi.fn(),
  };

  const paymentService = {
    findOneOrThrow: payment
      ? vi.fn().mockResolvedValue(payment)
      : vi.fn().mockRejectedValue(new Error('not found')),
    cancelPayment: vi.fn(),
  };

  const stateMachine = {
    getVivaTransaction: vi.fn(),
    getVivaTransactionByOrderCode: vi.fn().mockResolvedValue(vivaRow),
  };

  const options = { mode: 'isv' as const };

  return { orderService, paymentService, connection: {}, stateMachine, options };
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

describe('VivaShopApiResolver.orderByVivaReturn', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('happy path: customer-owned order → returns Order', async () => {
    const order = makeOrder({ id: 100, customerUserId: 42 });
    const payment = makePayment({ id: 99, orderId: 100 });
    const ctx = makeCtx({ activeUserId: 42 });

    const deps = buildDeps({ payment, order, vivaRow: makeVivaRow() });
    const resolver = buildResolver(deps);

    const result = (await resolver.orderByVivaReturn('123456789012', ctx)) as any;

    expect(result).not.toBeNull();
    expect(result.id).toBe(100);
    expect(deps.stateMachine.getVivaTransactionByOrderCode).toHaveBeenCalledWith(
      ctx,
      '123456789012',
    );
  });

  it('anonymous order happy path: session activeOrderId matches → returns Order', async () => {
    const order = makeOrder({ id: 200, customerUserId: null, customerId: null });
    const payment = makePayment({ id: 88, orderId: 200 });
    const ctx = makeCtx({ activeUserId: null, sessionActiveOrderId: 200 });

    const deps = buildDeps({ payment, order, vivaRow: makeVivaRow({ paymentId: 88 }) });
    const resolver = buildResolver(deps);

    const result = (await resolver.orderByVivaReturn('123456789012', ctx)) as any;

    expect(result).not.toBeNull();
    expect(result.id).toBe(200);
  });

  it('unknown vivaOrderCode (no row) → null', async () => {
    const ctx = makeCtx({ activeUserId: 42 });
    const deps = buildDeps({ vivaRow: null });
    deps.stateMachine.getVivaTransactionByOrderCode = vi.fn().mockResolvedValue(null);
    const resolver = buildResolver(deps);

    const result = await resolver.orderByVivaReturn('does-not-exist', ctx);

    expect(result).toBeNull();
    expect(deps.paymentService.findOneOrThrow).not.toHaveBeenCalled();
  });

  it('row without paymentId → null', async () => {
    const ctx = makeCtx({ activeUserId: 42 });
    const deps = buildDeps({ vivaRow: makeVivaRow({ paymentId: null }) });
    const resolver = buildResolver(deps);

    const result = await resolver.orderByVivaReturn('123456789012', ctx);

    expect(result).toBeNull();
    expect(deps.paymentService.findOneOrThrow).not.toHaveBeenCalled();
  });

  it('payment not found → null', async () => {
    const ctx = makeCtx({ activeUserId: 42 });
    const deps = buildDeps({ payment: null as any });
    deps.paymentService.findOneOrThrow = vi.fn().mockRejectedValue(new Error('not found'));
    const resolver = buildResolver(deps);

    const result = await resolver.orderByVivaReturn('123456789012', ctx);

    expect(result).toBeNull();
  });

  it('wrong customer → null (no enumeration signal, not an error)', async () => {
    const order = makeOrder({ id: 100, customerUserId: 42 });
    const payment = makePayment({ id: 99, orderId: 100 });
    const ctx = makeCtx({ activeUserId: 99, sessionActiveOrderId: null });

    const deps = buildDeps({ payment, order, activeOrder: null });
    const resolver = buildResolver(deps);

    const result = await resolver.orderByVivaReturn('123456789012', ctx);

    expect(result).toBeNull();
  });

  it('anonymous order, wrong session → null', async () => {
    const order = makeOrder({ id: 100, customerUserId: null, customerId: null });
    const payment = makePayment({ id: 99, orderId: 100 });
    const ctx = makeCtx({ activeUserId: null, sessionActiveOrderId: 999 });

    const deps = buildDeps({ payment, order, activeOrder: null });
    const resolver = buildResolver(deps);

    const result = await resolver.orderByVivaReturn('123456789012', ctx);

    expect(result).toBeNull();
  });

  it('empty vivaOrderCode arg → null (no lookup)', async () => {
    const ctx = makeCtx({ activeUserId: 42 });
    const deps = buildDeps();
    const resolver = buildResolver(deps);

    const result = await resolver.orderByVivaReturn('', ctx);

    expect(result).toBeNull();
    expect(deps.stateMachine.getVivaTransactionByOrderCode).not.toHaveBeenCalled();
  });
});
