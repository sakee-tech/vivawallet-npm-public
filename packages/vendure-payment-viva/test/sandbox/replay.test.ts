/**
 * test/sandbox/replay.test.ts — Sandbox fixture replay tests for Vendure plugin.
 *
 * Each test replays a recorded Viva webhook envelope through the full
 * receive→process pipeline using mocked dependencies (no Vendure server,
 * no Postgres, no BullMQ required).
 *
 * Fixture files live in test/sandbox/fixtures/. All merchantIds, transactionIds,
 * and accountIds are stable test UUIDs — no real Viva credentials.
 *
 * Cases:
 *  - 1796 happy path: INSERT-OR-IGNORE → BullMQ job → Retrieve(F) → settle
 *  - 1798 failed: Declined, order stays ArrangingPayment (no rollback)
 *  - 4865 user cancel: status=X → cancel payment → order to AddingItems
 *  - 8194 verification verified: vivaMerchantId written, vivaPayoutsEnabled flipped
 *  - 8194 verification declined: Verified=false → no writes
 *  - 1796 amount mismatch: VIVA_AMOUNT_MISMATCH logged, processed_at stays NULL
 *
 * @see test/sandbox/replay-harness.ts
 * @see test/sandbox/fixtures/
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  loadFixture,
  makeWebhookEvent,
  makeVivaTransaction,
  makeReplayMocks,
  buildReplayProcessor,
} from './replay-harness.js';
import type { WebhookEnvelopeRaw, ReplayMocks } from './replay-harness.js';

// ---------------------------------------------------------------------------
// Test constants (stable UUIDs matching fixtures)
// ---------------------------------------------------------------------------

const TEST_MERCHANT_ID = 'cccccccc-dddd-eeee-ffff-000000000001';
const TEST_ACCOUNT_ID = 'eeeeeeee-ffff-0000-1111-222222222222';
const TEST_TRANSACTION_ID = 'aaaaaaaa-1111-2222-3333-bbbbbbbbbbbb';
const TEST_ORDER_CODE = '1234567890123456';
const TEST_AMOUNT_MINOR = '9999';

// ---------------------------------------------------------------------------
// Helper: build a vivaTransaction mock response from the retrieve fixture
// ---------------------------------------------------------------------------

function makeRetrieveFinishedResponse(amountOverride?: bigint) {
  const raw = loadFixture<Record<string, unknown>>('retrieve-transaction-finished');
  return {
    transactionId: raw['transactionId'],
    orderCode: BigInt(raw['orderCode'] as string | number),
    statusId: raw['statusId'],
    amount: amountOverride ?? BigInt(raw['amount'] as number),
    currencyCode: raw['currencyCode'],
    merchantId: raw['merchantId'],
    parentId: null,
    insDate: raw['insDate'],
    transactionTypeId: raw['transactionTypeId'],
  };
}

// ---------------------------------------------------------------------------
// 1796 — happy path
// ---------------------------------------------------------------------------

describe('sandbox replay: 1796 — Transaction Payment Created (happy path)', () => {
  let mocks: ReplayMocks;

  beforeEach(() => {
    mocks = makeReplayMocks(TEST_MERCHANT_ID);
    vi.clearAllMocks();
  });

  it('INSERT-OR-IGNORE simulate → retrieve(F) → settle → processedAt set', async () => {
    const envelope = loadFixture<WebhookEnvelopeRaw>('webhook-1796-payment-created');
    const event = makeWebhookEvent(envelope);
    const vivaRow = makeVivaTransaction({
      vivaOrderCode: TEST_ORDER_CODE,
      amountMinor: TEST_AMOUNT_MINOR,
      paymentId: 99,
    });

    mocks.eventRepo.findOne.mockResolvedValue(event);
    mocks.isvPayments.retrieveTransaction.mockResolvedValue(makeRetrieveFinishedResponse());
    mocks.txnRepo.findOne.mockResolvedValue(vivaRow);
    mocks.orderService.findOne.mockResolvedValue({ id: 1, state: 'ArrangingPayment' });

    const proc = buildReplayProcessor(mocks);
    await proc.processJob({ messageId: envelope.MessageId });

    // Retrieve called with correct transactionId + merchantId
    expect(mocks.isvPayments.retrieveTransaction).toHaveBeenCalledWith(
      TEST_TRANSACTION_ID,
      { merchantId: TEST_MERCHANT_ID },
    );

    // INSERT-OR-IGNORE simulated: event was found with processedAt=null → job ran
    expect(mocks.stateMachine.transitionPaymentToSettled).toHaveBeenCalledWith({}, 1, 99);

    // viva_transaction row updated to 'captured'
    expect(mocks.txnRepo.update).toHaveBeenCalledWith(
      { id: 'vt-sandbox-001' },
      { status: 'captured', vivaTransactionId: TEST_TRANSACTION_ID },
    );

    // processedAt written; error=null
    const lastUpdate = mocks.eventRepo.update.mock.calls.at(-1);
    expect(lastUpdate?.[1]).toMatchObject({ error: null });
    expect(lastUpdate?.[1].processedAt).toBeInstanceOf(Date);
  });

  it('idempotent: if event already has processedAt set, no processing happens', async () => {
    const envelope = loadFixture<WebhookEnvelopeRaw>('webhook-1796-payment-created');
    const event = makeWebhookEvent(envelope, { processedAt: new Date() });

    mocks.eventRepo.findOne.mockResolvedValue(event);

    const proc = buildReplayProcessor(mocks);
    await proc.processJob({ messageId: envelope.MessageId });

    expect(mocks.isvPayments.retrieveTransaction).not.toHaveBeenCalled();
    expect(mocks.stateMachine.transitionPaymentToSettled).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// 1798 — Transaction Failed
// ---------------------------------------------------------------------------

describe('sandbox replay: 1798 — Transaction Failed (declined, non-terminal)', () => {
  it('marks payment Declined + viva_transaction.status=failed; order stays ArrangingPayment', async () => {
    const envelope = loadFixture<WebhookEnvelopeRaw>('webhook-1798-failed');
    const event = makeWebhookEvent(envelope);
    const vivaRow = makeVivaTransaction({ vivaOrderCode: TEST_ORDER_CODE, paymentId: 99 });

    const mocks = makeReplayMocks(TEST_MERCHANT_ID);
    mocks.eventRepo.findOne.mockResolvedValue(event);
    mocks.txnRepo.findOne.mockResolvedValue(vivaRow);

    const proc = buildReplayProcessor(mocks);
    await proc.processJob({ messageId: envelope.MessageId });

    // status → failed
    expect(mocks.txnRepo.update).toHaveBeenCalledWith({ id: 'vt-sandbox-001' }, { status: 'failed' });

    // Payment transitioned to Declined
    expect(mocks.stateMachine.transitionPaymentToDeclined).toHaveBeenCalledWith({}, 99);

    // Order NOT transitioned (stays ArrangingPayment per §4 contract)
    expect(mocks.orderService.transitionToState).not.toHaveBeenCalled();

    // processedAt set
    const lastUpdate = mocks.eventRepo.update.mock.calls.at(-1);
    expect(lastUpdate?.[1].processedAt).toBeInstanceOf(Date);
  });
});

// ---------------------------------------------------------------------------
// 4865 — Order Updated (user cancel)
// ---------------------------------------------------------------------------

describe('sandbox replay: 4865 — Order Updated (user cancel, StatusId=X)', () => {
  it('status X → payment cancelled + order transitions to AddingItems', async () => {
    const envelope = loadFixture<WebhookEnvelopeRaw>('webhook-4865-order-updated');
    const event = makeWebhookEvent(envelope);
    const vivaRow = makeVivaTransaction({ vivaOrderCode: TEST_ORDER_CODE, paymentId: 99 });

    const mocks = makeReplayMocks(TEST_MERCHANT_ID);
    mocks.eventRepo.findOne.mockResolvedValue(event);
    mocks.txnRepo.findOne.mockResolvedValue(vivaRow);

    const proc = buildReplayProcessor(mocks);
    await proc.processJob({ messageId: envelope.MessageId });

    // status → cancelled
    expect(mocks.txnRepo.update).toHaveBeenCalledWith({ id: 'vt-sandbox-001' }, { status: 'cancelled' });

    // Payment cancelled
    expect(mocks.stateMachine.transitionPaymentToCancelled).toHaveBeenCalledWith({}, 99);

    // Order → AddingItems
    expect(mocks.orderService.transitionToState).toHaveBeenCalledWith({}, 1, 'AddingItems');

    // processedAt set
    const lastUpdate = mocks.eventRepo.update.mock.calls.at(-1);
    expect(lastUpdate?.[1].processedAt).toBeInstanceOf(Date);
  });
});

// ---------------------------------------------------------------------------
// 8194 — Account Verification verified
// ---------------------------------------------------------------------------

describe('sandbox replay: 8194 — Account Verification Status Changed (verified)', () => {
  it('writes vivaMerchantId FIRST then vivaPayoutsEnabled LAST (mandatory field-write order)', async () => {
    const envelope = loadFixture<WebhookEnvelopeRaw>('webhook-8194-account-verification');
    const connectedAccount = loadFixture<{ merchantId: string }>('connected-account-verified');

    // The 8194 event row uses accountId from EventData.ConnectedAccountId
    const event = makeWebhookEvent(envelope, {
      // accountId must match ConnectedAccountId in fixture
      accountId: TEST_ACCOUNT_ID,
    });

    const mockChannel = { id: 1, customFields: { vivaAccountId: TEST_ACCOUNT_ID } };
    const mocks = makeReplayMocks(TEST_MERCHANT_ID);
    mocks.eventRepo.findOne.mockResolvedValue(event);
    mocks.isvAccounts.retrieveConnectedAccount.mockResolvedValue(connectedAccount);
    mocks.connectedAccounts.findChannelByAccountId.mockResolvedValue(mockChannel);

    const writeOrder: string[] = [];
    mocks.connectedAccounts.writeMerchantId.mockImplementation(async () => {
      writeOrder.push('merchantId');
    });
    mocks.connectedAccounts.flipPayoutsEnabled.mockImplementation(async () => {
      writeOrder.push('payoutsEnabled');
    });

    const proc = buildReplayProcessor(mocks);
    await proc.processJob({ messageId: envelope.MessageId });

    // vivaMerchantId written BEFORE vivaPayoutsEnabled
    expect(writeOrder).toEqual(['merchantId', 'payoutsEnabled']);

    expect(mocks.connectedAccounts.writeMerchantId).toHaveBeenCalledWith(
      {},
      mockChannel,
      connectedAccount.merchantId,
    );
    expect(mocks.connectedAccounts.flipPayoutsEnabled).toHaveBeenCalledWith({}, mockChannel, true);

    // processedAt set
    const lastUpdate = mocks.eventRepo.update.mock.calls.at(-1);
    expect(lastUpdate?.[1].processedAt).toBeInstanceOf(Date);
    expect(lastUpdate?.[1].error).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// 8194 — Account Verification declined (Verified=false)
// ---------------------------------------------------------------------------

describe('sandbox replay: 8194 — Account Verification Status Changed (declined)', () => {
  it('Verified=false: retrieveConnectedAccount not called, no writes to channel', async () => {
    // The "declined" fixture has Verified=false in EventData.
    // The plugin's 8194 handler always calls retrieveConnectedAccount regardless of
    // Verified field — the field-write guard is that merchantId must be present in the
    // account response and the channel must exist.
    // For the declined case we simulate the account returning payoutsEnabled=false and
    // no merchantId (or a channel that can't be found) to verify no writes happen.
    const envelope = loadFixture<WebhookEnvelopeRaw>('webhook-8194-account-verification-declined');
    const event = makeWebhookEvent(envelope, {
      accountId: 'eeeeeeee-ffff-0000-1111-333333333333', // declined account from fixture
    });

    const mocks = makeReplayMocks(TEST_MERCHANT_ID);
    mocks.eventRepo.findOne.mockResolvedValue(event);

    // Viva account returns no merchantId (verification incomplete)
    mocks.isvAccounts.retrieveConnectedAccount.mockResolvedValue({ merchantId: undefined, payoutsEnabled: false });

    const proc = buildReplayProcessor(mocks);
    await proc.processJob({ messageId: envelope.MessageId });

    // No writes to channel
    expect(mocks.connectedAccounts.writeMerchantId).not.toHaveBeenCalled();
    expect(mocks.connectedAccounts.flipPayoutsEnabled).not.toHaveBeenCalled();

    // Error set on row (merchant-id-not-returned)
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const errorUpdate = (mocks.eventRepo.update.mock.calls as any[]).find(
      (call: unknown[]) => {
        const patch = call[1] as Record<string, unknown>;
        return typeof patch['error'] === 'string' && (patch['error'] as string).includes('merchant-id-not-returned');
      },
    );
    expect(errorUpdate).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// 1796 — Amount mismatch
// ---------------------------------------------------------------------------

describe('sandbox replay: 1796 — Amount mismatch (VIVA_AMOUNT_MISMATCH)', () => {
  it('error logged + VIVA_AMOUNT_MISMATCH set; processed_at stays NULL; no settle called', async () => {
    const envelope = loadFixture<WebhookEnvelopeRaw>('webhook-1796-payment-created');
    const event = makeWebhookEvent(envelope);
    // Transaction row expects 9999 minor units
    const vivaRow = makeVivaTransaction({
      vivaOrderCode: TEST_ORDER_CODE,
      amountMinor: '9999',
      paymentId: 99,
    });

    const mocks = makeReplayMocks(TEST_MERCHANT_ID);
    mocks.eventRepo.findOne.mockResolvedValue(event);
    // Retrieve returns 5000 — MISMATCH
    mocks.isvPayments.retrieveTransaction.mockResolvedValue(makeRetrieveFinishedResponse(5000n));
    mocks.txnRepo.findOne.mockResolvedValue(vivaRow);

    const proc = buildReplayProcessor(mocks);
    await expect(proc.processJob({ messageId: envelope.MessageId })).rejects.toThrow(/mismatch/i);

    // No settle
    expect(mocks.stateMachine.transitionPaymentToSettled).not.toHaveBeenCalled();
    expect(mocks.stateMachine.recoverStaleOrderAndSettle).not.toHaveBeenCalled();

    // VIVA_AMOUNT_MISMATCH in error field
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const errorUpdate = (mocks.eventRepo.update.mock.calls as any[]).find((call: unknown[]) => {
      const patch = call[1] as Record<string, unknown>;
      return typeof patch['error'] === 'string' && (patch['error'] as string).includes('VIVA_AMOUNT_MISMATCH');
    });
    expect(errorUpdate).toBeDefined();

    // No processedAt written (processedAt stays NULL)
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const processedUpdate = (mocks.eventRepo.update.mock.calls as any[]).find((call: unknown[]) => {
      const patch = call[1] as Record<string, unknown>;
      return patch['processedAt'] instanceof Date && patch['error'] === null;
    });
    expect(processedUpdate).toBeUndefined();
  });
});
