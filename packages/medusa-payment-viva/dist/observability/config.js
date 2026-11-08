"use strict";
/**
 * config.ts — buildObservability(config) factory for medusa-payment-viva.
 *
 * Builds an ObservabilityContext from plugin config:
 *   - logger: StructuredJsonLogger → stdout, wrapped in RedactingLogger
 *   - metrics: PromMetricsHook (in-process Prometheus-compatible counters/histograms)
 *   - tracer: NoopTracerHook (SaaS wrapper wires a real tracer)
 *
 * @see references/viva-docs/md/isv-partner-program.txt:61 (P16 observability)
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.getSharedMetrics = getSharedMetrics;
exports.resetSharedMetrics = resetSharedMetrics;
exports.buildObservability = buildObservability;
const observability_1 = require("@sakeetech/viva-payments-core/observability");
const prom_metrics_js_1 = require("./prom-metrics.js");
// ---------------------------------------------------------------------------
// Singleton metrics hook shared across the plugin lifetime
// ---------------------------------------------------------------------------
let _sharedMetrics = null;
/**
 * Returns the shared PromMetricsHook instance (created on first call).
 * Exposed so routes can read toExposition() from the same instance.
 */
function getSharedMetrics() {
    if (!_sharedMetrics) {
        _sharedMetrics = new prom_metrics_js_1.PromMetricsHook();
    }
    return _sharedMetrics;
}
/**
 * Resets the shared metrics instance (for testing).
 */
function resetSharedMetrics() {
    _sharedMetrics = null;
}
// ---------------------------------------------------------------------------
// buildObservability
// ---------------------------------------------------------------------------
/**
 * Builds an ObservabilityContext for medusa-payment-viva.
 *
 * The returned context uses:
 *   - RedactingLogger(StructuredJsonLogger()) for structured JSON output
 *   - PromMetricsHook for Prometheus-compatible in-process metrics
 *   - NoopTracerHook (SaaS wrapper can override tracer after construction)
 *
 * @param config - resolved VivaPluginConfig (used for future per-tenant context)
 */
function buildObservability(_config) {
    const logger = new observability_1.RedactingLogger(new observability_1.StructuredJsonLogger());
    const metrics = getSharedMetrics();
    const tracer = new observability_1.NoopTracerHook();
    return { logger, metrics, tracer };
}
//# sourceMappingURL=config.js.map