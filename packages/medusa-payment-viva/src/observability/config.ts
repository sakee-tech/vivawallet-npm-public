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

import {
  StructuredJsonLogger,
  RedactingLogger,
  NoopTracerHook,
} from '@sakeetech/viva-payments-core/observability';
import type { ObservabilityContext } from '@sakeetech/viva-payments-core/observability';
import type { VivaPluginConfig } from '../config.js';
import { PromMetricsHook } from './prom-metrics.js';

// ---------------------------------------------------------------------------
// Singleton metrics hook shared across the plugin lifetime
// ---------------------------------------------------------------------------

let _sharedMetrics: PromMetricsHook | null = null;

/**
 * Returns the shared PromMetricsHook instance (created on first call).
 * Exposed so routes can read toExposition() from the same instance.
 */
export function getSharedMetrics(): PromMetricsHook {
  if (!_sharedMetrics) {
    _sharedMetrics = new PromMetricsHook();
  }
  return _sharedMetrics;
}

/**
 * Resets the shared metrics instance (for testing).
 */
export function resetSharedMetrics(): void {
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
export function buildObservability(_config: VivaPluginConfig): ObservabilityContext {
  const logger = new RedactingLogger(new StructuredJsonLogger());
  const metrics = getSharedMetrics();
  const tracer = new NoopTracerHook();

  return { logger, metrics, tracer };
}
