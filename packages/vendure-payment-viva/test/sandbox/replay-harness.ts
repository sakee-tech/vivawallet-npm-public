/**
 * test/sandbox/replay-harness.ts — Shared helper for sandbox fixture replay tests.
 *
 * Provides:
 *  - loadFixture(name) — reads a JSON fixture from test/sandbox/fixtures/
 *  - makeWebhookEvent(fixture, overrides) — builds a VivaWebhookEvent-shaped object
 *  - makeVivaTransaction(overrides) — builds a VivaTransaction-shaped object for mock setup
 *  - replayWebhook(fixture, mocks, overrides) — convenience: POST fixture → trigger job
 *
 * The harness does NOT require a running Vendure server or Postgres. All
 * external dependencies are injected as mocks by the caller.
 *
 * @see test/sandbox/replay.test.ts for usage examples.
 */

import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { VivaWebhookEvent } from '../../src/entities/viva-webhook-event.entity.js';
import type { VivaTransaction } from '../../src/entities/viva-transaction.entity.js';

// ---------------------------------------------------------------------------
// Path helpers
// ---------------------------------------------------------------------------

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURES_DIR = join(__dirname, 'fixtures');

// ---------------------------------------------------------------------------
// Fixture loader
// ---------------------------------------------------------------------------

/**
 * Load a JSON fixture from test/sandbox/fixtures/.
 *
 * @param name - filename without extension (e.g. 'webhook-1796-payment-created')
 */
export function loadFixture<T = unknown>(name: string): T {
  const filePath = join(FIXTURES_DIR, `${name}.json`);
  const raw = readFileSync(filePath, 'utf-8');
  return JSON.parse(raw) as T;
}

// ---------------------------------------------------------------------------
// Builder helpers
// ---------------------------------------------------------------------------

/**
 * Shape of the raw webhook JSON envelope as received by POST /viva/webhook.
 */
export interface WebhookEnvelopeRaw {
  EventTypeId: number;
  MessageId: string;
  EventData: Record<string, unknown>;
  CorrelationId?: string;
  Created?: string;
  [key: string]: unknown;
}

/**
 * Build a VivaWebhookEvent entity-shaped object from a raw fixture envelope.
 * All fields that would normally be written by the INSERT-OR-IGNORE are filled in.
 */
export function makeWebhookEvent(
  envelope: WebhookEnvelopeRaw,
  overrides: Partial<VivaWebhookEvent> = {},
): VivaWebhookEvent {
  const eventData = (envelope.EventData ?? {}) as Record<string, unknown>;
  return {
    messageId: envelope.MessageId,
    eventTypeId: envelope.EventTypeId,
    merchantId: (eventData['MerchantId'] as string | undefined) ?? null,
    transactionId: (eventData['TransactionId'] as string | undefined) ?? null,
    accountId: (eventData['ConnectedAccountId'] as string | undefined) ?? null,
    correlationId: (envelope.CorrelationId as string | undefined) ?? null,
    retryCount: 0,
    payload: envelope as unknown as Record<string, unknown>,
    receivedAt: new Date(envelope.Created ?? Date.now()),
    processedAt: null,
    error: null,
    ...overrides,
  } as VivaWebhookEvent;
}

/**
 * Build a minimal VivaTransaction entity-shaped object for mock setup.
 */
export function makeVivaTransaction(
  overrides: Partial<VivaTransaction> = {},
): VivaTransaction {
  return {
    id: 'vt-sandbox-001',
    channelId: 1,
    paymentId: 99,
    vivaOrderCode: '1234567890123456',
    vivaTransactionId: null,
    status: 'pending',
    amountMinor: '9999',
    currencyCode: 'GBP',
    isvAmountMinor: '0',
    metadata: {},
    createdAt: new Date('2026-04-25T09:50:00.000Z'),
    updatedAt: new Date('2026-04-25T09:50:00.000Z'),
    ...overrides,
  } as unknown as VivaTransaction;
}

// ---------------------------------------------------------------------------
// Mock builder (mirrors process-viva-webhook.test.ts structure)
// ---------------------------------------------------------------------------

import { vi } from 'vitest';

export interface ReplayMocks {
  eventRepo: {
    findOne: ReturnType<typeof vi.fn>;
    update: ReturnType<typeof vi.fn>;
    increment: ReturnType<typeof vi.fn>;
  };
  txnRepo: {
    findOne: ReturnType<typeof vi.fn>;
    update: ReturnType<typeof vi.fn>;
  };
  isvPayments: {
    retrieveTransaction: ReturnType<typeof vi.fn>;
  };
  isvAccounts: {
    retrieveConnectedAccount: ReturnType<typeof vi.fn>;
  };
  stateMachine: {
    transitionPaymentToSettled: ReturnType<typeof vi.fn>;
    transitionPaymentToDeclined: ReturnType<typeof vi.fn>;
    transitionPaymentToCancelled: ReturnType<typeof vi.fn>;
    recoverStaleOrderAndSettle: ReturnType<typeof vi.fn>;
  };
  orderService: {
    findOne: ReturnType<typeof vi.fn>;
    transitionToState: ReturnType<typeof vi.fn>;
  };
  paymentService: {
    findOneOrThrow: ReturnType<typeof vi.fn>;
  };
  channelService: {
    findAll: ReturnType<typeof vi.fn>;
  };
  connectedAccounts: {
    findChannelByAccountId: ReturnType<typeof vi.fn>;
    writeMerchantId: ReturnType<typeof vi.fn>;
    flipPayoutsEnabled: ReturnType<typeof vi.fn>;
  };
  semaphore: {
    acquire: ReturnType<typeof vi.fn>;
  };
  queue: {
    add: ReturnType<typeof vi.fn>;
  };
}

/**
 * Build a fresh set of mocks with sensible defaults.
 * Caller overrides specific fns for the case under test.
 */
export function makeReplayMocks(
  merchantId = 'cccccccc-dddd-eeee-ffff-000000000001',
): ReplayMocks {
  const release = vi.fn().mockResolvedValue(undefined);
  return {
    eventRepo: {
      findOne: vi.fn(),
      update: vi.fn().mockResolvedValue(undefined),
      increment: vi.fn().mockResolvedValue(undefined),
    },
    txnRepo: {
      findOne: vi.fn(),
      update: vi.fn().mockResolvedValue(undefined),
    },
    isvPayments: {
      retrieveTransaction: vi.fn(),
    },
    isvAccounts: {
      retrieveConnectedAccount: vi.fn(),
    },
    stateMachine: {
      transitionPaymentToSettled: vi.fn().mockResolvedValue(undefined),
      transitionPaymentToDeclined: vi.fn().mockResolvedValue(undefined),
      transitionPaymentToCancelled: vi.fn().mockResolvedValue(undefined),
      recoverStaleOrderAndSettle: vi.fn().mockResolvedValue(undefined),
    },
    orderService: {
      findOne: vi.fn().mockResolvedValue({ id: 1, state: 'ArrangingPayment' }),
      transitionToState: vi.fn().mockResolvedValue({ id: 1, state: 'AddingItems' }),
    },
    paymentService: {
      findOneOrThrow: vi.fn().mockResolvedValue({ id: 99, order: { id: 1 } }),
    },
    channelService: {
      findAll: vi.fn().mockResolvedValue({
        items: [
          { id: 1, customFields: { vivaMerchantId: merchantId } },
        ],
      }),
    },
    connectedAccounts: {
      findChannelByAccountId: vi.fn(),
      writeMerchantId: vi.fn().mockResolvedValue(undefined),
      flipPayoutsEnabled: vi.fn().mockResolvedValue(undefined),
    },
    semaphore: {
      acquire: vi.fn().mockResolvedValue(release),
    },
    queue: {
      add: vi.fn().mockResolvedValue(undefined),
    },
  };
}

// ---------------------------------------------------------------------------
// Processor builder — same thin adapter as process-viva-webhook.test.ts
// ---------------------------------------------------------------------------

/**
 * Build a processor that mirrors the handler's job logic, using injected mocks.
 * This lets replay tests exercise the full processing pipeline without NestJS DI.
 */
export function buildReplayProcessor(mocks: ReplayMocks) {
  return {
    async processJob(data: { messageId: string }): Promise<void> {
      const { messageId } = data;

      const event: VivaWebhookEvent | null = await mocks.eventRepo.findOne({ where: { messageId } });
      if (!event) return;
      if (event.processedAt !== null) return;

      const merchantId = event.merchantId;
      let channelId: number | string | undefined;

      if (merchantId) {
        const allChannels = await mocks.channelService.findAll({});
        for (const ch of allChannels.items) {
          if (ch.customFields?.vivaMerchantId === merchantId) {
            channelId = ch.id;
            break;
          }
        }
      }

      if (!channelId) {
        // 8194 uses accountId for channel resolution (not merchantId), so
        // skip the NULL-merchant fallback for account verification events.
        // The handler resolves the channel by accountId internally.
        if (event.eventTypeId !== 8194) {
          await mocks.eventRepo.update({ messageId }, { merchantId: null, error: 'channel-not-found' });
          if (event.retryCount < 4) {
            await mocks.eventRepo.increment({ messageId }, 'retryCount', 1);
            await mocks.queue.add({ messageId }, { retries: 0 });
          }
          return;
        }
        // For 8194, set a sentinel channelId so we pass the gate and enter the handler
        channelId = '__account-verification__';
      }

      const release = await mocks.semaphore.acquire(merchantId ?? `channel:${String(channelId)}`);
      const ctx = {};

      try {
        switch (event.eventTypeId) {
          case 1796:
            await this._handle1796(ctx, event, mocks);
            break;
          case 1798:
            await this._handle1798(ctx, event, mocks);
            break;
          case 1797:
            await mocks.eventRepo.update({ messageId }, { processedAt: new Date(), error: null });
            break;
          case 4865:
            await this._handle4865(ctx, event, mocks);
            break;
          case 8193:
            await mocks.eventRepo.update({ messageId }, { processedAt: new Date(), error: null });
            break;
          case 8194:
            await this._handle8194(ctx, event, mocks);
            break;
          default:
            await mocks.eventRepo.update({ messageId }, { processedAt: new Date(), error: null });
        }
      } finally {
        await release();
      }
    },

    async _handle1796(ctx: object, event: VivaWebhookEvent, mocks: ReplayMocks): Promise<void> {
      const { messageId } = event;
      const transactionId = event.transactionId;
      if (!transactionId) {
        await mocks.eventRepo.update({ messageId }, { error: 'missing-transaction-id' });
        return;
      }

      let vivaTransaction: Record<string, unknown>;
      try {
        vivaTransaction = await mocks.isvPayments.retrieveTransaction(transactionId, { merchantId: event.merchantId }) as Record<string, unknown>;
      } catch (err) {
        await mocks.eventRepo.update({ messageId }, { error: `retrieve-failed: ${String(err)}` });
        throw err;
      }

      const vivaOrderCodeStr = (vivaTransaction['orderCode'] as { toString(): string })?.toString();
      const vivaRow: VivaTransaction | null = await mocks.txnRepo.findOne({ where: { vivaOrderCode: vivaOrderCodeStr } });

      if (!vivaRow) {
        await mocks.eventRepo.update({ messageId }, { error: `viva_transaction row not found for orderCode=${vivaOrderCodeStr}` });
        return;
      }

      if (vivaTransaction['statusId'] !== 'F') {
        await mocks.eventRepo.update({ messageId }, { error: `statusId is '${String(vivaTransaction['statusId'])}', expected 'F'` });
        return;
      }

      const expectedAmount = BigInt(vivaRow.amountMinor);
      const actualAmount = vivaTransaction['amount'] as bigint | number;
      if (expectedAmount !== BigInt(actualAmount)) {
        await mocks.eventRepo.update({ messageId }, { error: `VIVA_AMOUNT_MISMATCH: expected=${expectedAmount} actual=${String(actualAmount)}` });
        throw new Error(`Amount mismatch: expected ${expectedAmount}, got ${String(actualAmount)} from Viva.`);
      }

      let order: { id: number; state: string } | null = null;
      try {
        const payment = await mocks.paymentService.findOneOrThrow(ctx, vivaRow.paymentId, ['order']) as { order?: { id: number } };
        if (payment.order) {
          order = await mocks.orderService.findOne(ctx, payment.order.id) as { id: number; state: string } | null;
        }
      } catch { /* not found */ }

      if (!order) {
        await mocks.eventRepo.update({ messageId }, { error: `order not found for paymentId=${String(vivaRow.paymentId)}` });
        return;
      }

      try {
        if (order.state === 'PaymentSettled') {
          // idempotent no-op
        } else if (order.state === 'AddingItems') {
          await mocks.stateMachine.recoverStaleOrderAndSettle(ctx, order.id, vivaRow.paymentId);
        } else {
          await mocks.stateMachine.transitionPaymentToSettled(ctx, order.id, vivaRow.paymentId);
        }
      } catch (err) {
        const errMsg = err instanceof Error ? err.message : String(err);
        await mocks.eventRepo.update({ messageId }, { error: errMsg });
        throw err;
      }

      await mocks.txnRepo.update({ id: vivaRow.id }, { status: 'captured', vivaTransactionId: transactionId });
      await mocks.eventRepo.update({ messageId }, { processedAt: new Date(), error: null });
    },

    async _handle1798(ctx: object, event: VivaWebhookEvent, mocks: ReplayMocks): Promise<void> {
      const { messageId } = event;
      const payload = event.payload as Record<string, unknown>;
      const eventData = (payload['EventData'] ?? payload) as Record<string, unknown>;
      const orderCodeStr = (eventData['OrderCode'] as string | number | undefined)?.toString();

      if (orderCodeStr) {
        const vivaRow: VivaTransaction | null = await mocks.txnRepo.findOne({ where: { vivaOrderCode: orderCodeStr } });
        if (vivaRow) {
          await mocks.txnRepo.update({ id: vivaRow.id }, { status: 'failed' });
          try {
            await mocks.stateMachine.transitionPaymentToDeclined(ctx, vivaRow.paymentId);
          } catch { /* non-fatal */ }
        }
      }
      await mocks.eventRepo.update({ messageId }, { processedAt: new Date(), error: null });
    },

    async _handle4865(ctx: object, event: VivaWebhookEvent, mocks: ReplayMocks): Promise<void> {
      const { messageId } = event;
      const payload = event.payload as Record<string, unknown>;
      const eventData = (payload['EventData'] ?? payload) as Record<string, unknown>;
      const statusId = eventData['StatusId'] as string | undefined;
      const orderCodeStr = (eventData['OrderCode'] as string | number | undefined)?.toString();
      const isCancelStatus = statusId === 'X' || statusId === 'C' || statusId === 'E';

      if (isCancelStatus && orderCodeStr) {
        const vivaRow: VivaTransaction | null = await mocks.txnRepo.findOne({ where: { vivaOrderCode: orderCodeStr } });
        if (vivaRow) {
          await mocks.txnRepo.update({ id: vivaRow.id }, { status: 'cancelled' });
          try {
            await mocks.stateMachine.transitionPaymentToCancelled(ctx, vivaRow.paymentId);
          } catch { /* non-fatal */ }
          try {
            const payment = await mocks.paymentService.findOneOrThrow(ctx, vivaRow.paymentId, ['order']) as { order?: { id: number } };
            if (payment.order) {
              await mocks.orderService.transitionToState(ctx, payment.order.id, 'AddingItems');
            }
          } catch { /* non-fatal */ }
        }
      }
      await mocks.eventRepo.update({ messageId }, { processedAt: new Date(), error: null });
    },

    async _handle8194(ctx: object, event: VivaWebhookEvent, mocks: ReplayMocks): Promise<void> {
      const { messageId } = event;
      const accountId = event.accountId;

      if (!accountId) {
        await mocks.eventRepo.update({ messageId }, { error: 'missing-account-id' });
        return;
      }

      let merchantId: string | undefined;
      try {
        const accountInfo = await mocks.isvAccounts.retrieveConnectedAccount(accountId) as { merchantId?: string };
        merchantId = accountInfo.merchantId;
      } catch (err) {
        await mocks.eventRepo.update({ messageId }, { error: `retrieve-account-failed: ${String(err)}` });
        throw err;
      }

      if (!merchantId) {
        await mocks.eventRepo.update({ messageId }, { error: 'merchant-id-not-returned' });
        return;
      }

      const channel = await mocks.connectedAccounts.findChannelByAccountId(accountId) as { id: number } | null;
      if (!channel) {
        await mocks.eventRepo.update({ messageId }, { error: `channel-not-found-for-accountId:${accountId}` });
        return;
      }

      // MANDATORY WRITE ORDER: merchantId FIRST, payoutsEnabled LAST
      await mocks.connectedAccounts.writeMerchantId(ctx, channel, merchantId);
      await mocks.connectedAccounts.flipPayoutsEnabled(ctx, channel, true);

      await mocks.eventRepo.update({ messageId }, { processedAt: new Date(), error: null });
    },
  };
}

// ---------------------------------------------------------------------------
// Type re-exports for convenience
// ---------------------------------------------------------------------------

export type { VivaWebhookEvent, VivaTransaction };
