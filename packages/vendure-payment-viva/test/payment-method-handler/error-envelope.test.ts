/**
 * test/payment-method-handler/error-envelope.test.ts
 *
 * Tests all VivaPluginError factory methods and toJSON shape.
 */

import { describe, it, expect } from 'vitest';
import { VivaPluginError } from '../../src/util/error-envelope.js';

describe('VivaPluginError factories', () => {
  it('authDown → code=VIVA_AUTH_DOWN, retryable=true', () => {
    const err = VivaPluginError.authDown('service unavailable');
    expect(err.code).toBe('VIVA_AUTH_DOWN');
    expect(err.retryable).toBe(true);
    expect(err.message).toBe('service unavailable');
    expect(err).toBeInstanceOf(Error);
    expect(err).toBeInstanceOf(VivaPluginError);
  });

  it('apiError → code=VIVA_API_ERROR, retryable=false, passes through vivaErrorCode', () => {
    const err = VivaPluginError.apiError({ message: 'bad request', vivaErrorCode: 1234, vivaErrorMessage: 'Bad' });
    expect(err.code).toBe('VIVA_API_ERROR');
    expect(err.retryable).toBe(false);
    expect(err.vivaErrorCode).toBe(1234);
    expect(err.vivaErrorMessage).toBe('Bad');
  });

  it('apiError without vivaErrorCode → fields undefined', () => {
    const err = VivaPluginError.apiError({ message: 'bad' });
    expect(err.vivaErrorCode).toBeUndefined();
    expect(err.vivaErrorMessage).toBeUndefined();
  });

  it('accountNotVerified → code=VIVA_ACCOUNT_NOT_VERIFIED, retryable=false', () => {
    const err = VivaPluginError.accountNotVerified();
    expect(err.code).toBe('VIVA_ACCOUNT_NOT_VERIFIED');
    expect(err.retryable).toBe(false);
  });

  it('accountNotVerified with custom message', () => {
    const err = VivaPluginError.accountNotVerified('custom msg');
    expect(err.message).toBe('custom msg');
  });

  it('isvAmountTooHigh → code=VIVA_ISV_AMOUNT_TOO_HIGH, retryable=false', () => {
    const err = VivaPluginError.isvAmountTooHigh(500, 400);
    expect(err.code).toBe('VIVA_ISV_AMOUNT_TOO_HIGH');
    expect(err.retryable).toBe(false);
    expect(err.message).toContain('500');
    expect(err.message).toContain('400');
  });

  it('channelMisconfigured → code=VIVA_CHANNEL_MISCONFIGURED, retryable=false', () => {
    const err = VivaPluginError.channelMisconfigured();
    expect(err.code).toBe('VIVA_CHANNEL_MISCONFIGURED');
    expect(err.retryable).toBe(false);
  });

  it('orderNotFound → code=VIVA_ORDER_NOT_FOUND', () => {
    const err = VivaPluginError.orderNotFound();
    expect(err.code).toBe('VIVA_ORDER_NOT_FOUND');
    expect(err.retryable).toBe(false);
  });

  it('amountMismatch → code=VIVA_AMOUNT_MISMATCH', () => {
    const err = VivaPluginError.amountMismatch(1000n, 999n);
    expect(err.code).toBe('VIVA_AMOUNT_MISMATCH');
    expect(err.message).toContain('1000');
    expect(err.message).toContain('999');
  });

  it('refundRejected → code=VIVA_REFUND_REJECTED, retryable=false', () => {
    const err = VivaPluginError.refundRejected('not captured');
    expect(err.code).toBe('VIVA_REFUND_REJECTED');
    expect(err.retryable).toBe(false);
  });

  it('paymentAlreadySettled → code=VIVA_PAYMENT_ALREADY_SETTLED', () => {
    const err = VivaPluginError.paymentAlreadySettled();
    expect(err.code).toBe('VIVA_PAYMENT_ALREADY_SETTLED');
    expect(err.retryable).toBe(false);
  });

  it('paymentNotCancellable → code=VIVA_PAYMENT_NOT_CANCELLABLE', () => {
    const err = VivaPluginError.paymentNotCancellable('already captured');
    expect(err.code).toBe('VIVA_PAYMENT_NOT_CANCELLABLE');
    expect(err.retryable).toBe(false);
    expect(err.message).toBe('already captured');
  });

  it('internalError → code=VIVA_INTERNAL_ERROR, retryable=false', () => {
    const err = VivaPluginError.internalError('bug');
    expect(err.code).toBe('VIVA_INTERNAL_ERROR');
    expect(err.retryable).toBe(false);
  });

  it('toJSON includes all expected fields', () => {
    const err = VivaPluginError.apiError({ message: 'fail', vivaErrorCode: 42, vivaErrorMessage: 'Nope' });
    const json = err.toJSON();
    expect(json).toEqual({
      code: 'VIVA_API_ERROR',
      message: 'fail',
      retryable: false,
      vivaErrorCode: 42,
      vivaErrorMessage: 'Nope',
    });
  });

  it('toJSON omits undefined optional fields', () => {
    const err = VivaPluginError.authDown('down');
    const json = err.toJSON();
    expect(Object.keys(json)).not.toContain('vivaErrorCode');
    expect(Object.keys(json)).not.toContain('vivaErrorMessage');
  });

  it('cause is preserved on error chain', () => {
    const cause = new Error('root cause');
    const err = VivaPluginError.authDown('wrapped', cause);
    expect(err.cause).toBe(cause);
  });
});
