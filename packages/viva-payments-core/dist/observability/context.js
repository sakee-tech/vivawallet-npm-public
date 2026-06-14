"use strict";
/**
 * context.ts — ObservabilityContext composite type and defaultContext() factory.
 *
 * The SaaS wrapper builds one ObservabilityContext at startup and threads it
 * through provider construction. defaultContext() returns a fully-wired
 * context suitable for standalone use (StructuredJsonLogger → stdout, etc.).
 *
 * @see references/viva-docs/md/isv-partner-program.txt:61 (P16 observability)
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.defaultContext = defaultContext;
exports.silentContext = silentContext;
const logger_js_1 = require("./logger.js");
const metrics_js_1 = require("./metrics.js");
const tracer_js_1 = require("./tracer.js");
// ---------------------------------------------------------------------------
// defaultContext
// ---------------------------------------------------------------------------
/**
 * Returns a ready-to-use ObservabilityContext with:
 *   - StructuredJsonLogger (stdout) wrapped in RedactingLogger
 *   - NoopMetricsHook (replaced by PromMetricsHook in medusa package)
 *   - NoopTracerHook
 */
function defaultContext() {
    return {
        logger: new logger_js_1.RedactingLogger(new logger_js_1.StructuredJsonLogger()),
        metrics: new metrics_js_1.NoopMetricsHook(),
        tracer: new tracer_js_1.NoopTracerHook(),
    };
}
/**
 * Returns a silent ObservabilityContext suitable for tests.
 * Suppresses all log output; metrics are no-op.
 */
function silentContext() {
    return {
        logger: new logger_js_1.SilentLogger(),
        metrics: new metrics_js_1.NoopMetricsHook(),
        tracer: new tracer_js_1.NoopTracerHook(),
    };
}
//# sourceMappingURL=context.js.map