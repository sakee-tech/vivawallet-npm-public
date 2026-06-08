/**
 * metrics.test.ts — NoopMetricsHook unit tests.
 */

import { describe, it, expect, vi } from 'vitest';
import { NoopMetricsHook } from '../../src/observability/metrics.js';

describe('NoopMetricsHook', () => {
  it('counter does nothing observable', () => {
    const hook = new NoopMetricsHook();
    // Should not throw
    expect(() => hook.counter('viva_test_total')).not.toThrow();
    expect(() => hook.counter('viva_test_total', { label: 'val' }, 5)).not.toThrow();
  });

  it('histogram does nothing observable', () => {
    const hook = new NoopMetricsHook();
    expect(() => hook.histogram('viva_test_seconds', 0.1)).not.toThrow();
    expect(() => hook.histogram('viva_test_seconds', 0.05, { endpoint: 'POST /orders' })).not.toThrow();
  });

  it('timeAsync records duration on success and returns the result', async () => {
    const hook = new NoopMetricsHook();
    const histSpy = vi.spyOn(hook, 'histogram');

    const result = await hook.timeAsync('viva_api_request_duration_seconds', async () => {
      return 'expected-result';
    });

    expect(result).toBe('expected-result');
    expect(histSpy).toHaveBeenCalledOnce();
    const [name, duration, labels] = histSpy.mock.calls[0]!;
    expect(name).toBe('viva_api_request_duration_seconds');
    expect(duration).toBeGreaterThanOrEqual(0);
    expect(labels).toBeUndefined();
  });

  it('timeAsync records duration with status=error on rejection and rethrows', async () => {
    const hook = new NoopMetricsHook();
    const histSpy = vi.spyOn(hook, 'histogram');
    const error = new Error('network failure');

    await expect(
      hook.timeAsync('viva_api_request_duration_seconds', async () => {
        throw error;
      }, { endpoint: 'POST /orders' }),
    ).rejects.toThrow('network failure');

    expect(histSpy).toHaveBeenCalledOnce();
    const [name, duration, labels] = histSpy.mock.calls[0]!;
    expect(name).toBe('viva_api_request_duration_seconds');
    expect(duration).toBeGreaterThanOrEqual(0);
    expect(labels).toMatchObject({ endpoint: 'POST /orders', status: 'error' });
  });

  it('timeAsync with no labels on rejection still adds status=error', async () => {
    const hook = new NoopMetricsHook();
    const histSpy = vi.spyOn(hook, 'histogram');

    await expect(
      hook.timeAsync('viva_test', async () => { throw new Error('fail'); }),
    ).rejects.toThrow();

    const [, , labels] = histSpy.mock.calls[0]!;
    expect(labels).toMatchObject({ status: 'error' });
  });
});
