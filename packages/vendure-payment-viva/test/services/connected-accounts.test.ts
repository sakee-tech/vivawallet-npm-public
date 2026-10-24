/**
 * test/services/connected-accounts.test.ts — unit tests for the channel
 * write-back helpers used to close the ISV onboarding loop.
 *
 * Covers the two methods added for the source/payment-method gap:
 *   - writeSourceCode: String()-coerces the numeric Viva sourceCode before
 *     writing it into the string-typed `vivaSourceCode` channel field.
 *   - assignVivaPaymentMethod: looks the PaymentMethod up by handler code and
 *     skips gracefully (no throw) when none exists.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ConnectedAccountsService } from '../../src/services/connected-accounts.service.js';

function makeService(paymentMethods: Array<{ id: string; handler?: { code: string } }>) {
  const channelService = { update: vi.fn().mockResolvedValue(undefined) };
  const paymentMethodService = {
    assignPaymentMethodsToChannel: vi.fn().mockResolvedValue([]),
  };
  const connection = {
    rawConnection: {
      getRepository: vi.fn().mockReturnValue({
        find: vi.fn().mockResolvedValue(paymentMethods),
      }),
    },
  };
  const svc = new ConnectedAccountsService(
    channelService as any,
    connection as any,
    paymentMethodService as any,
  );
  return { svc, channelService, paymentMethodService };
}

describe('ConnectedAccountsService.writeSourceCode', () => {
  beforeEach(() => {
    vi.spyOn(console, 'info').mockReturnValue(undefined);
    vi.spyOn(console, 'warn').mockReturnValue(undefined);
  });

  it('String-coerces a numeric sourceCode into the string field', async () => {
    const { svc, channelService } = makeService([]);
    await svc.writeSourceCode({} as any, { id: 'ch-1' } as any, 1234);
    expect(channelService.update).toHaveBeenCalledWith(
      {},
      { id: 'ch-1', customFields: { vivaSourceCode: '1234' } },
    );
    // value written must be a string, never a number
    const written = channelService.update.mock.calls[0]![1].customFields.vivaSourceCode;
    expect(typeof written).toBe('string');
  });

  it('passes a string sourceCode through unchanged', async () => {
    const { svc, channelService } = makeService([]);
    await svc.writeSourceCode({} as any, { id: 'ch-1' } as any, 'Default');
    expect(channelService.update.mock.calls[0]![1].customFields.vivaSourceCode).toBe('Default');
  });
});

describe('ConnectedAccountsService.assignVivaPaymentMethod', () => {
  beforeEach(() => {
    vi.spyOn(console, 'info').mockReturnValue(undefined);
    vi.spyOn(console, 'warn').mockReturnValue(undefined);
  });

  it('assigns the PaymentMethod whose handler code is "viva"', async () => {
    const { svc, paymentMethodService } = makeService([
      { id: 'pm-other', handler: { code: 'stripe' } },
      { id: 'pm-viva', handler: { code: 'viva' } },
    ]);
    const result = await svc.assignVivaPaymentMethod({} as any, { id: 'ch-1' } as any);
    expect(result).toBe(true);
    expect(paymentMethodService.assignPaymentMethodsToChannel).toHaveBeenCalledWith(
      {},
      { paymentMethodIds: ['pm-viva'], channelId: 'ch-1' },
    );
  });

  it('skips gracefully (returns false, no throw) when no viva method exists', async () => {
    const { svc, paymentMethodService } = makeService([
      { id: 'pm-other', handler: { code: 'stripe' } },
    ]);
    const result = await svc.assignVivaPaymentMethod({} as any, { id: 'ch-1' } as any);
    expect(result).toBe(false);
    expect(paymentMethodService.assignPaymentMethodsToChannel).not.toHaveBeenCalled();
  });
});
