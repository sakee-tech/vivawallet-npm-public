/**
 * prom-metrics.test.ts — PromMetricsHook unit tests.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { PromMetricsHook } from '../../src/observability/prom-metrics.js';

describe('PromMetricsHook', () => {
  let hook: PromMetricsHook;

  beforeEach(() => {
    hook = new PromMetricsHook();
  });

  // -------------------------------------------------------------------------
  // Counter tests
  // -------------------------------------------------------------------------

  it('counter increments and exposition shows total', () => {
    hook.counter('viva_webhook_received_total', { event_type_id: '1796', result: 'accepted' });
    hook.counter('viva_webhook_received_total', { event_type_id: '1796', result: 'accepted' });
    hook.counter('viva_webhook_received_total', { event_type_id: '1796', result: 'accepted' }, 3);

    const exp = hook.toExposition();
    // Should contain the counter with value 5
    expect(exp).toContain('viva_webhook_received_total{event_type_id="1796",result="accepted"} 5');
  });

  it('counter default value is 1', () => {
    hook.counter('viva_tenant_resolution_failures_total');
    const exp = hook.toExposition();
    expect(exp).toContain('viva_tenant_resolution_failures_total 1');
  });

  it('counter with different labels produces separate rows', () => {
    hook.counter('viva_webhook_received_total', { event_type_id: '1796', result: 'accepted' });
    hook.counter('viva_webhook_received_total', { event_type_id: '1797', result: 'duplicate' });

    const exp = hook.toExposition();
    expect(exp).toContain('event_type_id="1796",result="accepted"} 1');
    expect(exp).toContain('event_type_id="1797",result="duplicate"} 1');
  });

  // -------------------------------------------------------------------------
  // Histogram tests
  // -------------------------------------------------------------------------

  it('histogram bucketing: 100 observations at 0.05s land in correct buckets', () => {
    for (let i = 0; i < 100; i++) {
      hook.histogram('viva_api_request_duration_seconds', 0.05, { endpoint: 'GET /orders' });
    }

    const exp = hook.toExposition();

    // 0.05 <= 0.05 — should land in 0.05 bucket and all higher buckets
    // Buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, +Inf]
    // 0.05 should NOT land in 0.005, 0.01, 0.025 buckets
    expect(exp).toContain(`le="0.005"} 0`);
    expect(exp).toContain(`le="0.01"} 0`);
    expect(exp).toContain(`le="0.025"} 0`);
    // 0.05 should land in 0.05 bucket
    expect(exp).toContain(`le="0.05"} 100`);
    // And all higher buckets
    expect(exp).toContain(`le="0.1"} 100`);
    expect(exp).toContain(`le="+Inf"} 100`);

    // sum and count
    expect(exp).toContain(`viva_api_request_duration_seconds_count`);
    const countMatch = exp.match(/viva_api_request_duration_seconds_count\{[^}]+\} (\d+)/);
    expect(countMatch?.[1]).toBe('100');

    const sumMatch = exp.match(/viva_api_request_duration_seconds_sum\{[^}]+\} ([\d.]+)/);
    const sum = parseFloat(sumMatch?.[1] ?? '0');
    expect(sum).toBeCloseTo(0.05 * 100, 5);
  });

  it('histogram with multiple label sets produces separate rows', () => {
    hook.histogram('viva_api_request_duration_seconds', 0.1, { endpoint: 'POST /orders' });
    hook.histogram('viva_api_request_duration_seconds', 0.2, { endpoint: 'GET /transactions' });

    const exp = hook.toExposition();
    expect(exp).toContain('endpoint="POST /orders"');
    expect(exp).toContain('endpoint="GET /transactions"');
  });

  // -------------------------------------------------------------------------
  // Exposition format
  // -------------------------------------------------------------------------

  it('exposition output contains # HELP and # TYPE for known metrics', () => {
    hook.counter('viva_webhook_received_total', { event_type_id: '1796', result: 'accepted' });
    hook.histogram('viva_auth_token_refresh_duration_seconds', 0.5);

    const exp = hook.toExposition();
    expect(exp).toContain('# HELP viva_webhook_received_total');
    expect(exp).toContain('# TYPE viva_webhook_received_total counter');
    expect(exp).toContain('# HELP viva_auth_token_refresh_duration_seconds');
    expect(exp).toContain('# TYPE viva_auth_token_refresh_duration_seconds histogram');
  });

  it('toExposition returns empty string when no metrics recorded', () => {
    expect(hook.toExposition()).toBe('');
  });

  // -------------------------------------------------------------------------
  // timeAsync
  // -------------------------------------------------------------------------

  it('timeAsync wraps a promise and records histogram on success', async () => {
    const result = await hook.timeAsync(
      'viva_api_request_duration_seconds',
      async () => 'ok',
      { endpoint: 'GET /test' },
    );
    expect(result).toBe('ok');
    const exp = hook.toExposition();
    expect(exp).toContain('viva_api_request_duration_seconds');
    expect(exp).toContain('endpoint="GET /test"');
  });

  it('timeAsync records with status=error on rejection and rethrows', async () => {
    await expect(
      hook.timeAsync('viva_api_request_duration_seconds', async () => {
        throw new Error('fail');
      }, { endpoint: 'POST /orders' }),
    ).rejects.toThrow('fail');

    const exp = hook.toExposition();
    expect(exp).toContain('status="error"');
  });
});
