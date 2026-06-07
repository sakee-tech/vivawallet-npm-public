/**
 * context.ts — ObservabilityContext composite type and defaultContext() factory.
 *
 * The SaaS wrapper builds one ObservabilityContext at startup and threads it
 * through provider construction. defaultContext() returns a fully-wired
 * context suitable for standalone use (StructuredJsonLogger → stdout, etc.).
 *
 * @see references/viva-docs/md/isv-partner-program.txt:61 (P16 observability)
 */
import { StructuredJsonLogger, RedactingLogger, SilentLogger } from './logger.js';
import { NoopMetricsHook } from './metrics.js';
import { NoopTracerHook } from './tracer.js';
// ---------------------------------------------------------------------------
// defaultContext
// ---------------------------------------------------------------------------
/**
 * Returns a ready-to-use ObservabilityContext with:
 *   - StructuredJsonLogger (stdout) wrapped in RedactingLogger
 *   - NoopMetricsHook (replaced by PromMetricsHook in medusa package)
 *   - NoopTracerHook
 */
export function defaultContext() {
    return {
        logger: new RedactingLogger(new StructuredJsonLogger()),
        metrics: new NoopMetricsHook(),
        tracer: new NoopTracerHook(),
    };
}
/**
 * Returns a silent ObservabilityContext suitable for tests.
 * Suppresses all log output; metrics are no-op.
 */
export function silentContext() {
    return {
        logger: new SilentLogger(),
        metrics: new NoopMetricsHook(),
        tracer: new NoopTracerHook(),
    };
}
//# sourceMappingURL=context.js.map