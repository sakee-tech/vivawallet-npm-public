"use strict";
/**
 * tracer.ts — OpenTelemetry tracer hook interface and no-op default.
 *
 * Pass-through (no-op) by default. The SaaS wrapper wires a real tracer
 * implementing OTelTracerHook and injects it via ObservabilityContext.
 *
 * @see references/viva-docs/md/isv-partner-program.txt:61 (P16 OTel hook)
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.NoopTracerHook = void 0;
// ---------------------------------------------------------------------------
// NoopTracerHook
// ---------------------------------------------------------------------------
class NoopTracerHook {
    async startActiveSpan(_name, fn) {
        return fn();
    }
    setAttribute(_key, _value) { }
}
exports.NoopTracerHook = NoopTracerHook;
//# sourceMappingURL=tracer.js.map