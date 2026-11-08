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
export declare class PromMetricsHook implements MetricsHook {
    /** metric_name -> labelHash -> value */
    private readonly _counters;
    /** metric_name -> HistogramState */
    private readonly _histograms;
    counter(name: string, labels?: MetricLabels, value?: number): void;
    histogram(name: string, valueSeconds: number, labels?: MetricLabels): void;
    timeAsync<T>(name: string, fn: () => Promise<T>, labels?: MetricLabels): Promise<T>;
    /**
     * Returns Prometheus text format (v0.0.4) for scraping.
     * Includes # HELP and # TYPE lines for known metrics.
     */
    toExposition(): string;
    /** `${name}\x00${hash}` -> labels object */
    private readonly _counterLabels;
    private readonly _histogramLabels;
}
//# sourceMappingURL=prom-metrics.d.ts.map