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
// ---------------------------------------------------------------------------
// NoopMetricsHook
// ---------------------------------------------------------------------------
export class NoopMetricsHook {
    counter(_name, _labels, _value) { }
    histogram(_name, _valueSeconds, _labels) { }
    async timeAsync(name, fn, labels) {
        const start = process.hrtime.bigint();
        try {
            const result = await fn();
            const durationSec = Number(process.hrtime.bigint() - start) / 1e9;
            this.histogram(name, durationSec, labels);
            return result;
        }
        catch (err) {
            const durationSec = Number(process.hrtime.bigint() - start) / 1e9;
            this.histogram(name, durationSec, { ...labels, status: 'error' });
            throw err;
        }
    }
}
//# sourceMappingURL=metrics.js.map