/**
 * test/merchant-mode/webhook-1796-merchant.test.ts
 *
 * Slice B — merchant-mode webhook handler 1796 (payment-created).
 *
 * Verifies:
 *   1. Channel resolution uses ChannelService.getDefaultChannel — NOT the
 *      ISV-style linear scan by EventData.MerchantId.
 *   2. The retrieveTransaction call is built WITHOUT a merchantId option
 *      (URL: /checkout/v2/transactions/{id}, no /isv segment, no query).
 *   3. 8194 webhook events are no-op in merchant mode (no
 *      writeMerchantId / flipPayoutsEnabled call).
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ProcessVivaWebhookHandler } from '../../src/jobs/process-viva-webhook.handler.js';
import type { VivaWebhookEvent } from '../../src/entities/viva-webhook-event.entity.js';
import type { VivaTransaction } from '../../src/entities/viva-transaction.entity.js';

// ---------------------------------------------------------------------------
// Builder for a handler instance with all deps mocked
// ---------------------------------------------------------------------------

function makeMerchantHandler() {
  const handler = Object.create(ProcessVivaWebhookHandler.prototype) as ProcessVivaWebhookHandler;

  const eventRepo = {
    findOne: vi.fn(),
    update: vi.fn().mockResolvedValue(undefined),
    increment: vi.fn().mockResolvedValue(undefined),
  };
  const txnRepo = {
    findOne: vi.fn(),
    update: vi.fn().mockResolvedValue(undefined),
  };
  const release = vi.fn().mockResolvedValue(undefined);
  const semaphore = { acquire: vi.fn().mockResolvedValue(release) };
  const stateMachine = {
    transitionPaymentToSettled: vi.fn().mockResolvedValue(undefined),
    transitionPaymentToDeclined: vi.fn().mockResolvedValue(undefined),
    transitionPaymentToCancelled: vi.fn().mockResolvedValue(undefined),
    recoverStaleOrderAndSettle: vi.fn().mockResolvedValue(undefined),
  };
  const paymentService = {
    findOneOrThrow: vi.fn().mockResolvedValue({ id: 99, order: { id: 1 } }),
  };
  const orderService = {
    findOne: vi.fn().mockResolvedValue({ id: 1, state: 'ArrangingPayment' }),
    transitionToState: vi.fn(),
  };
  const channelService = {
    findAll: vi.fn(), // should NOT be called in merchant mode
    findOne: vi.fn().mockResolvedValue({ id: 1, code: 'default' }),
    getDefaultChannel: vi.fn().mockResolvedValue({ id: 1, code: 'default' }),
  };
  const requestContextService = {
    create: vi.fn().mockResolvedValue({}),
  };
  const connectedAccounts = {
    findChannelByAccountId: vi.fn(),
    writeMerchantId: vi.fn().mockResolvedValue(undefined),
    flipPayoutsEnabled: vi.fn().mockResolvedValue(undefined),
  };
  const retrieveTransaction = vi.fn();
  const isvPayments = { retrieveTransaction };

  (handler as any).connection = {
    rawConnection: {
      getRepository: (entity: any) => {
        // Match by reference is brittle in a test — switch on entity name string
        const name = (entity?.name ?? entity?.constructor?.name ?? String(entity)) as string;
        if (name.includes('Event') || name === 'VivaWebhookEvent') return eventRepo;
        return txnRepo;
      },
    },
  };
  (handler as any).stateMachine = stateMachine;
  (handler as any).semaphore = semaphore;
  (handler as any).connectedAccounts = connectedAccounts;
  (handler as any).orderService = orderService;
  (handler as any).paymentService = paymentService;
  (handler as any).channelService = channelService;
  (handler as any).requestContextService = requestContextService;
  (handler as any).options = {
    mode: 'merchant',
    environment: 'demo',
    clientId: 'test',
    clientSecret: 'test',
    legacyMerchantId: 'test-legacy',
    legacyApiKey: 'test-key',
    webhookVerificationKey: 'verify',
    successUrl: '',
    failureUrl: '',
  };
  (handler as any).oauth2 = {};
  (handler as any).queue = { add: vi.fn() };

  // Replace _getIsvPayments to return our mock without constructing real HTTP clients.
  (handler as any)._getIsvPayments = () => isvPayments;

  return {
    handler,
    mocks: {
      eventRepo,
      txnRepo,
      semaphore,
      stateMachine,
      paymentService,
      orderService,
      channelService,
      connectedAccounts,
      retrieveTransaction,
    },
  };
}

function makeEvent(overrides: Partial<VivaWebhookEvent> = {}): VivaWebhookEvent {
  return {
    messageId: 'msg-merchant-001',
    eventTypeId: 1796,
    merchantId: null, // Merchant mode webhooks may or may not carry MerchantId
    transactionId: 'txn-abc',
    accountId: null,
    correlationId: null,
    retryCount: 0,
    processedAt: null,
    error: null,
    receivedAt: new Date(),
    payload: { EventData: { TransactionId: 'txn-abc', OrderCode: 9876543210 } },
    ...overrides,
  } as unknown as VivaWebhookEvent;
}

function makeRow(overrides: Partial<VivaTransaction> = {}): VivaTransaction {
  return {
    id: 'vt-001',
    channelId: 1,
    paymentId: 99,
    vivaOrderCode: '9876543210',
    vivaTransactionId: null,
    status: 'pending',
    amountMinor: '2000',
    currencyCode: 'EUR',
    isvAmountMinor: '0',
    metadata: {},
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  } as unknown as VivaTransaction;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('merchant-mode webhook 1796 — payment created', () => {
  let h: ReturnType<typeof makeMerchantHandler>;

  beforeEach(() => {
    h = makeMerchantHandler();
  });

  it('resolves channel via getDefaultChannel (no per-merchantId scan)', async () => {
    h.mocks.eventRepo.findOne.mockResolvedValue(makeEvent());
    h.mocks.txnRepo.findOne.mockResolvedValue(makeRow());
    h.mocks.retrieveTransaction.mockResolvedValue({
      transactionId: 'txn-abc',
      orderCode: 9876543210n,
      statusId: 'F',
      amount: 2000n,
    });

    await (h.handler as any)._processJob({ data: { messageId: 'msg-merchant-001' } });

    expect(h.mocks.channelService.getDefaultChannel).toHaveBeenCalledTimes(1);
    // ISV-style linear scan must not run in merchant mode.
    expect(h.mocks.channelService.findAll).not.toHaveBeenCalled();
  });

  it('retrieveTransaction called WITHOUT merchantId option (merchant mode)', async () => {
    h.mocks.eventRepo.findOne.mockResolvedValue(makeEvent({ merchantId: null }));
    h.mocks.txnRepo.findOne.mockResolvedValue(makeRow());
    h.mocks.retrieveTransaction.mockResolvedValue({
      transactionId: 'txn-abc',
      orderCode: 9876543210n,
      statusId: 'F',
      amount: 2000n,
    });

    await (h.handler as any)._processJob({ data: { messageId: 'msg-merchant-001' } });

    expect(h.mocks.retrieveTransaction).toHaveBeenCalledTimes(1);
    const callArgs = h.mocks.retrieveTransaction.mock.calls[0];
    expect(callArgs![0]).toBe('txn-abc');
    // Second arg must be {} (no merchantId field) in merchant mode.
    expect(callArgs![1]).toEqual({});

    // Settled path executed.
    expect(h.mocks.stateMachine.transitionPaymentToSettled).toHaveBeenCalledTimes(1);
  });

  it('8194 verification event is a no-op in merchant mode', async () => {
    h.mocks.eventRepo.findOne.mockResolvedValue(
      makeEvent({ eventTypeId: 8194, accountId: 'acct-1', transactionId: null }),
    );

    await (h.handler as any)._processJob({ data: { messageId: 'msg-merchant-001' } });

    expect(h.mocks.connectedAccounts.writeMerchantId).not.toHaveBeenCalled();
    expect(h.mocks.connectedAccounts.flipPayoutsEnabled).not.toHaveBeenCalled();
    // Event still gets marked processed so it doesn't reprocess forever.
    expect(h.mocks.eventRepo.update).toHaveBeenCalledWith(
      { messageId: 'msg-merchant-001' },
      expect.objectContaining({ processedAt: expect.any(Date) }),
    );
  });
});
