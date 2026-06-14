/**
 * prom-metrics.ts — Hand-rolled Prometheus-compatible MetricsHook.
 *
 * Does NOT depend on prom-client. Stores counters and histograms in-process
 * and exports them via toExposition() in Prometheus text format (v0.0.4).
 *
 * Histogram buckets (seconds):
 *   [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, +Inf]
 *
 * Metric names emitted:
 *   viva_auth_token_refresh_duration_seconds  (histogram)
 *   viva_api_request_duration_seconds         (histogram, endpoint + status labels)
 *   viva_webhook_received_total               (counter, event_type_id + result)
 *   viva_webhook_processing_lag_seconds       (histogram)
 *   viva_tenant_resolution_failures_total     (counter)
 *   viva_webhook_lattice_reject_total         (counter, reason)
 *   viva_webhook_ordercode_mismatch_total     (counter, event_type_id)
 *   viva_tenant_resolution_retry_resolved_total (counter)
 *   viva_tenant_resolution_abandoned_total    (counter)
 *
 * @see references/viva-docs/md/isv-partner-program.txt:61 (P16 observability)
 */

import type { MetricLabels, MetricsHook } from '@sakeetech/viva-payments-core/observability';

// ---------------------------------------------------------------------------
// Histogram internal state
// ---------------------------------------------------------------------------

interface HistogramState {
  /** Sorted upper-bound bucket thresholds (seconds). +Inf not stored explicitly. */
  readonly buckets: readonly number[];
  /** labelHash → per-bucket cumulative count array (parallel to buckets, plus +Inf) */
  readonly counts: Map<string, number[]>;
  readonly sum: Map<string, number>;
  readonly count: Map<string, number>;
}

// ---------------------------------------------------------------------------
// Metric metadata (HELP + TYPE lines)
// ---------------------------------------------------------------------------

interface MetricMeta {
  help: string;
  type: 'counter' | 'histogram';
}

const METRIC_META: Record<string, MetricMeta> = {
  viva_auth_token_refresh_duration_seconds: {
    help: 'Duration of Viva OAuth2 token refresh requests in seconds.',
    type: 'histogram',
  },
  viva_api_request_duration_seconds: {
    help: 'Duration of outbound Viva ISV API requests in seconds.',
    type: 'histogram',
  },
  viva_webhook_received_total: {
    help: 'Total number of Viva webhook events received, by event_type_id and result.',
    type: 'counter',
  },
  viva_webhook_processing_lag_seconds: {
    help: 'Lag in seconds between webhook Created timestamp and processing time.',
    type: 'histogram',
  },
  viva_tenant_resolution_failures_total: {
    help: 'Total number of failed tenant resolution attempts.',
    type: 'counter',
  },
  viva_webhook_lattice_reject_total: {
    help: 'Total number of webhook events rejected by the status lattice.',
    type: 'counter',
  },
  viva_webhook_ordercode_mismatch_total: {
    help: 'Total number of webhook events rejected because envelope.OrderCode did not match live.orderCode from retrieveTransaction (potential spoof attempt). See docs/TODO-CSO.md Finding 1.',
    type: 'counter',
  },
  viva_tenant_resolution_retry_resolved_total: {
    help: 'Total number of tenant resolutions that succeeded on retry.',
    type: 'counter',
  },
  viva_tenant_resolution_abandoned_total: {
    help: 'Total number of tenant resolutions abandoned after exhausting retries.',
    type: 'counter',
  },
};

// ---------------------------------------------------------------------------
// Default histogram buckets (seconds)
// ---------------------------------------------------------------------------

const DEFAULT_BUCKETS: readonly number[] = [
  0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10,
];

// ---------------------------------------------------------------------------
// Label hash helpers
// ---------------------------------------------------------------------------

function hashLabels(labels: MetricLabels | undefined): string {
  if (!labels || Object.keys(labels).length === 0) return '';
  const sorted = Object.keys(labels).sort();
  return sorted.map((k) => `${k}=${String(labels[k])}`).join(',');
}

function labelsToPromString(labels: MetricLabels | undefined): string {
  if (!labels || Object.keys(labels).length === 0) return '';
  const sorted = Object.keys(labels).sort();
  const parts = sorted.map((k) => `${k}="${String(labels[k])}"`);
  return `{${parts.join(',')}}`;
}

// ---------------------------------------------------------------------------
// PromMetricsHook
// ---------------------------------------------------------------------------

export class PromMetricsHook implements MetricsHook {
  /** metric_name -> labelHash -> value */
  private readonly _counters = new Map<string, Map<string, number>>();

  /** metric_name -> HistogramState */
  private readonly _histograms = new Map<string, HistogramState>();

  // ---------------------------------------------------------------------------
  // MetricsHook implementation
  // ---------------------------------------------------------------------------

  counter(name: string, labels?: MetricLabels, value = 1): void {
    let byLabel = this._counters.get(name);
    if (!byLabel) {
      byLabel = new Map<string, number>();
      this._counters.set(name, byLabel);
    }
    const hash = hashLabels(labels);
    byLabel.set(hash, (byLabel.get(hash) ?? 0) + value);
    // Store labels for later serialization
    this._counterLabels.set(`${name}\x00${hash}`, labels ?? {});
  }

  histogram(name: string, valueSeconds: number, labels?: MetricLabels): void {
    let state = this._histograms.get(name);
    if (!state) {
      state = {
        buckets: DEFAULT_BUCKETS,
        counts: new Map(),
        sum: new Map(),
        count: new Map(),
      };
      this._histograms.set(name, state);
    }

    const hash = hashLabels(labels);
    // Store labels for later serialization
    this._histogramLabels.set(`${name}\x00${hash}`, labels ?? {});

    // Initialize bucket array if needed
    if (!state.counts.has(hash)) {
      // +1 for the +Inf bucket
      state.counts.set(hash, new Array<number>(DEFAULT_BUCKETS.length + 1).fill(0));
    }

    const bucketCounts = state.counts.get(hash)!;

    // Increment all buckets where le >= value
    for (let i = 0; i < DEFAULT_BUCKETS.length; i++) {
      if (valueSeconds <= (DEFAULT_BUCKETS[i] as number)) {
        bucketCounts[i] = (bucketCounts[i] ?? 0) + 1;
      }
    }
    // +Inf bucket always incremented
    bucketCounts[DEFAULT_BUCKETS.length] = (bucketCounts[DEFAULT_BUCKETS.length] ?? 0) + 1;

    state.sum.set(hash, (state.sum.get(hash) ?? 0) + valueSeconds);
    state.count.set(hash, (state.count.get(hash) ?? 0) + 1);
  }

  async timeAsync<T>(name: string, fn: () => Promise<T>, labels?: MetricLabels): Promise<T> {
    const start = process.hrtime.bigint();
    try {
      const result = await fn();
      const durationSec = Number(process.hrtime.bigint() - start) / 1e9;
      this.histogram(name, durationSec, labels);
      return result;
    } catch (err) {
      const durationSec = Number(process.hrtime.bigint() - start) / 1e9;
      this.histogram(name, durationSec, { ...labels, status: 'error' });
      throw err;
    }
  }

  // ---------------------------------------------------------------------------
  // Prometheus text format exposition
  // ---------------------------------------------------------------------------

  /**
   * Returns Prometheus text format (v0.0.4) for scraping.
   * Includes # HELP and # TYPE lines for known metrics.
   */
  toExposition(): string {
    const lines: string[] = [];

    // Counters
    for (const [name, byLabel] of this._counters) {
      const meta = METRIC_META[name];
      if (meta) {
        lines.push(`# HELP ${name} ${meta.help}`);
        lines.push(`# TYPE ${name} counter`);
      } else {
        lines.push(`# TYPE ${name} counter`);
      }
      for (const [hash, value] of byLabel) {
        const labels = this._counterLabels.get(`${name}\x00${hash}`) ?? {};
        const labelStr = labelsToPromString(labels);
        lines.push(`${name}${labelStr} ${value}`);
      }
      lines.push('');
    }

    // Histograms
    for (const [name, state] of this._histograms) {
      const meta = METRIC_META[name];
      if (meta) {
        lines.push(`# HELP ${name} ${meta.help}`);
        lines.push(`# TYPE ${name} histogram`);
      } else {
        lines.push(`# TYPE ${name} histogram`);
      }

      for (const [hash, bucketCounts] of state.counts) {
        const labels = this._histogramLabels.get(`${name}\x00${hash}`) ?? {};

        // Emit per-bucket lines
        for (let i = 0; i < DEFAULT_BUCKETS.length; i++) {
          const le = DEFAULT_BUCKETS[i] as number;
          const leStr = le.toString();
          const bucketLabels: MetricLabels = { ...labels, le: leStr };
          const labelStr = labelsToPromString(bucketLabels);
          lines.push(`${name}_bucket${labelStr} ${bucketCounts[i] ?? 0}`);
        }
        // +Inf bucket
        const infLabels: MetricLabels = { ...labels, le: '+Inf' };
        lines.push(`${name}_bucket${labelsToPromString(infLabels)} ${bucketCounts[DEFAULT_BUCKETS.length] ?? 0}`);

        // sum and count
        const labelStr = labelsToPromString(labels);
        lines.push(`${name}_sum${labelStr} ${state.sum.get(hash) ?? 0}`);
        lines.push(`${name}_count${labelStr} ${state.count.get(hash) ?? 0}`);
      }
      lines.push('');
    }

    return lines.join('\n');
  }

  // ---------------------------------------------------------------------------
  // Internal label stores (for serialization)
  // ---------------------------------------------------------------------------

  /** `${name}\x00${hash}` -> labels object */
  private readonly _counterLabels = new Map<string, MetricLabels>();
  private readonly _histogramLabels = new Map<string, MetricLabels>();
}
