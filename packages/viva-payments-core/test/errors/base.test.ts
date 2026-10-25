import { describe, it, expect } from 'vitest';
import { VivaError } from '../../src/errors/base.js';
import { VivaAuthError } from '../../src/errors/auth-error.js';
import { VivaApiError } from '../../src/errors/api-error.js';
import { VivaValidationError } from '../../src/errors/validation-error.js';
import { VivaWebhookError } from '../../src/errors/webhook-error.js';
import { VivaRateLimitError } from '../../src/errors/rate-limit-error.js';

describe('VivaError subclasses', () => {
  it('each subclass has the correct code', () => {
    expect(new VivaAuthError({ message: 'x' }).code).toBe('VIVA_AUTH_ERROR');
    expect(new VivaApiError({ message: 'x' }).code).toBe('VIVA_API_ERROR');
    expect(new VivaValidationError({ message: 'x' }).code).toBe('VIVA_VALIDATION_ERROR');
    expect(new VivaWebhookError({ message: 'x' }).code).toBe('VIVA_WEBHOOK_ERROR');
    expect(new VivaRateLimitError({ message: 'x' }).code).toBe('VIVA_RATE_LIMIT_ERROR');
  });

  it('each subclass has the correct name', () => {
    expect(new VivaAuthError({ message: 'x' }).name).toBe('VivaAuthError');
    expect(new VivaApiError({ message: 'x' }).name).toBe('VivaApiError');
    expect(new VivaValidationError({ message: 'x' }).name).toBe('VivaValidationError');
    expect(new VivaWebhookError({ message: 'x' }).name).toBe('VivaWebhookError');
    expect(new VivaRateLimitError({ message: 'x' }).name).toBe('VivaRateLimitError');
  });

  it('cause is preserved through VivaApiError', () => {
    const inner = new Error('root cause');
    const err = new VivaApiError({ message: 'outer', cause: inner });
    expect(err.cause).toBe(inner);
    expect((err.cause as Error).message).toBe('root cause');
  });

  it('instanceof VivaError works for each subclass', () => {
    const instances = [
      new VivaAuthError({ message: 'x' }),
      new VivaApiError({ message: 'x' }),
      new VivaValidationError({ message: 'x' }),
      new VivaWebhookError({ message: 'x' }),
      new VivaRateLimitError({ message: 'x' }),
    ];
    for (const err of instances) {
      expect(err).toBeInstanceOf(VivaError);
      expect(err).toBeInstanceOf(Error);
    }
  });

  it('VivaRateLimitError exposes retriable=true and retryAfterMs', () => {
    const err = new VivaRateLimitError({ message: 'rate limited', retryAfterMs: 5000 });
    expect(err.retriable).toBe(true);
    expect(err.retryAfterMs).toBe(5000);
  });

  it('optional fields are preserved', () => {
    const err = new VivaApiError({
      message: 'api error',
      vivaCode: 'E001',
      httpStatus: 422,
      requestId: 'req-123',
    });
    expect(err.vivaCode).toBe('E001');
    expect(err.httpStatus).toBe(422);
    expect(err.requestId).toBe('req-123');
  });

  it('stack trace is defined', () => {
    const err = new VivaAuthError({ message: 'stack test' });
    expect(err.stack).toBeDefined();
    expect(typeof err.stack).toBe('string');
  });
});
