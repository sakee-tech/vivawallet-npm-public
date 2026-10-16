/**
 * metrics.ts — MetricsHook interface, NoopMetricsHook, and helpers.
 *
 * MetricsHook is the canonical observability hook for Viva payment metrics.
 * The SaaS wrapper injects a real implementation; the default is NoopMetricsHook.
 *
 * Metric names (P16):
 *   viva_auth_token_refresh_duration_seconds  (histogram)
 *   viva_api_request_duration_seconds         (histogram, labels: endpoint, status)
 *   viva_webhook_received_total               (counter, labels: event_type_id, result)
 *   viva_webhook_processing_lag_seconds       (histogram)
 *   viva_tenant_resolution_failures_total     (counter)
 *   viva_webhook_lattice_reject_total         (counter, labels: reason)
 *   viva_tenant_resolution_retry_resolved_total (counter)
 *   viva_tenant_resolution_abandoned_total    (counter)
 *
 * @see references/viva-docs/md/isv-partner-program.txt:61 (P16 observability)
 */
export type MetricLabels = Readonly<Record<string, string | number>>;
export interface MetricsHook {
    /** Increment a counter. Default value: 1. */
    counter(name: string, labels?: MetricLabels, value?: number): void;
    /** Record a histogram observation (value in seconds). */
    histogram(name: string, valueSeconds: number, labels?: MetricLabels): void;
    /**
     * Wraps a promise: measures wall-clock duration, records as histogram.
     * On success: histogram(name, durationSec, labels).
     * On rejection: histogram(name, durationSec, { ...labels, status: 'error' }) then rethrow.
     */
    timeAsync<T>(name: string, fn: () => Promise<T>, labels?: MetricLabels): Promise<T>;
}
export declare class NoopMetricsHook implements MetricsHook {
    counter(_name: string, _labels?: MetricLabels, _value?: number): void;
    histogram(_name: string, _valueSeconds: number, _labels?: MetricLabels): void;
    timeAsync<T>(name: string, fn: () => Promise<T>, labels?: MetricLabels): Promise<T>;
}
//# sourceMappingURL=metrics.d.ts.map