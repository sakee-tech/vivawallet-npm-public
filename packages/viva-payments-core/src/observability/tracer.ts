/**
 * tracer.ts — OpenTelemetry tracer hook interface and no-op default.
 *
 * Pass-through (no-op) by default. The SaaS wrapper wires a real tracer
 * implementing OTelTracerHook and injects it via ObservabilityContext.
 *
 * @see references/viva-docs/md/isv-partner-program.txt:61 (P16 OTel hook)
 */

// ---------------------------------------------------------------------------
// OTelTracerHook interface
// ---------------------------------------------------------------------------

export interface OTelTracerHook {
  /**
   * Wraps fn in a span named `name`.
   * No-op implementation just calls fn() directly.
   */
  startActiveSpan<T>(name: string, fn: () => Promise<T>): Promise<T>;

  /**
   * Adds an attribute to the current active span (if any).
   * No-op implementation is a silent stub.
   */
  setAttribute(key: string, value: string | number | boolean): void;
}

// ---------------------------------------------------------------------------
// NoopTracerHook
// ---------------------------------------------------------------------------

export class NoopTracerHook implements OTelTracerHook {
  async startActiveSpan<T>(_name: string, fn: () => Promise<T>): Promise<T> {
    return fn();
  }

  setAttribute(_key: string, _value: string | number | boolean): void {}
}
