/**
 * context.ts — ObservabilityContext composite type and defaultContext() factory.
 *
 * The SaaS wrapper builds one ObservabilityContext at startup and threads it
 * through provider construction. defaultContext() returns a fully-wired
 * context suitable for standalone use (StructuredJsonLogger → stdout, etc.).
 *
 * @see references/viva-docs/md/isv-partner-program.txt:61 (P16 observability)
 */
import type { Logger } from './logger.js';
import type { MetricsHook } from './metrics.js';
import type { OTelTracerHook } from './tracer.js';
export interface ObservabilityContext {
    readonly logger: Logger;
    readonly metrics: MetricsHook;
    readonly tracer: OTelTracerHook;
}
/**
 * Returns a ready-to-use ObservabilityContext with:
 *   - StructuredJsonLogger (stdout) wrapped in RedactingLogger
 *   - NoopMetricsHook (replaced by PromMetricsHook in medusa package)
 *   - NoopTracerHook
 */
export declare function defaultContext(): ObservabilityContext;
/**
 * Returns a silent ObservabilityContext suitable for tests.
 * Suppresses all log output; metrics are no-op.
 */
export declare function silentContext(): ObservabilityContext;
//# sourceMappingURL=context.d.ts.map