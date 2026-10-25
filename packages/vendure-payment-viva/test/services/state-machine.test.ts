/**
 * test/services/state-machine.test.ts — thrown transition errors carry the
 * step name + errorCode, never order/payment ids or the raw result payload.
 */

import { describe, it, expect, vi } from 'vitest';
import { Logger } from '@vendure/core';
import { StateMachineService } from '../../src/services/state-machine.service.js';

const ORDER_ID = 'order-1234567890';
const PAYMENT_ID = 'payment-9876543210';
const result = { errorCode: 'ORDER_STATE_TRANSITION_ERROR', message: `Order ${ORDER_ID} cannot transition`, transitionError: PAYMENT_ID };

function svc() {
  vi.spyOn(Logger, 'info').mockReturnValue(undefined);
  vi.spyOn(Logger, 'error').mockReturnValue(undefined);
  const orderService = {
    settlePayment: vi.fn().mockResolvedValue(result),
    transitionToState: vi.fn().mockResolvedValue(result),
  };
  return { s: new StateMachineService({} as any, orderService as any, {} as any), orderService };
}

async function thrown(p: Promise<unknown>): Promise<string> {
  const err = await p.then(() => null, (e: Error) => e);
  expect(err).toBeInstanceOf(Error);
  return err!.message;
}

function expectIdFree(msg: string) {
  for (const id of [ORDER_ID, PAYMENT_ID, 'cannot transition']) expect(msg).not.toContain(id);
  expect(msg).toContain('ORDER_STATE_TRANSITION_ERROR');
}

describe('StateMachineService thrown errors carry no identifiers', () => {
  it('transitionPaymentToSettled', async () => {
    const { s } = svc();
    const msg = await thrown(s.transitionPaymentToSettled({} as any, ORDER_ID, PAYMENT_ID));
    expectIdFree(msg);
    expect(msg).toContain('settlePayment');
  });

  it('stale re-walk, step 1 (AddingItems→ArrangingPayment)', async () => {
    const { s } = svc();
    const msg = await thrown(s.recoverStaleOrderAndSettle({} as any, ORDER_ID, PAYMENT_ID));
    expectIdFree(msg);
    expect(msg).toContain('AddingItems→ArrangingPayment');
  });

  it('stale re-walk, step 2 (settlePayment)', async () => {
    const { s, orderService } = svc();
    orderService.transitionToState.mockResolvedValue({ id: 1, state: 'ArrangingPayment' });
    const msg = await thrown(s.recoverStaleOrderAndSettle({} as any, ORDER_ID, PAYMENT_ID));
    expectIdFree(msg);
    expect(msg).toContain('settlePayment');
  });
});
