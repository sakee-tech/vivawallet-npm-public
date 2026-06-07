/**
 * logger.ts — Structured JSON logger types and implementations.
 *
 * Logger interface mandated by P16:
 *   - debug / info / warn / error with LogContext
 *   - child() for bound-context loggers
 *
 * StructuredJsonLogger: emits one JSON line per call to stdout.
 *   - bigint values serialized to string
 *   - Error causes serialized to { name, message, stack }
 *
 * RedactingLogger: wraps another logger; redacts PCI fields from ctx before
 *   forwarding via redact() from redact.ts.
 *
 * @see references/viva-docs/md/isv-partner-program.txt:61 (P16 observability)
 */
export interface LogContext {
    trace_id?: string;
    tenant_id?: string;
    viva_merchant_id?: string;
    /** bigint serialized to string for log lines */
    viva_order_code?: string;
    viva_transaction_id?: string;
    event_type_id?: number;
    [k: string]: unknown;
}
export interface Logger {
    debug(msg: string, ctx?: LogContext): void;
    info(msg: string, ctx?: LogContext): void;
    warn(msg: string, ctx?: LogContext): void;
    error(msg: string, ctx?: LogContext & {
        cause?: unknown;
    }): void;
    /** Returns a new logger with these fields auto-merged into every log call. */
    child(bind: LogContext): Logger;
}
export declare class SilentLogger implements Logger {
    debug(_msg: string, _ctx?: LogContext): void;
    info(_msg: string, _ctx?: LogContext): void;
    warn(_msg: string, _ctx?: LogContext): void;
    error(_msg: string, _ctx?: LogContext & {
        cause?: unknown;
    }): void;
    child(_bind: LogContext): Logger;
}
/**
 * Emits to stdout one JSON object per line.
 * Bigints → string. Errors → { name, message, stack }.
 */
export declare class StructuredJsonLogger implements Logger {
    private readonly _bound;
    private readonly _out;
    constructor(opts?: {
        bound?: LogContext;
        out?: (line: string) => void;
    });
    debug(msg: string, ctx?: LogContext): void;
    info(msg: string, ctx?: LogContext): void;
    warn(msg: string, ctx?: LogContext): void;
    error(msg: string, ctx?: LogContext & {
        cause?: unknown;
    }): void;
    child(bind: LogContext): Logger;
    private _emit;
}
/**
 * Wraps another logger; redacts known PCI fields from ctx.* before forwarding.
 */
export declare class RedactingLogger implements Logger {
    private readonly _inner;
    constructor(_inner: Logger);
    debug(msg: string, ctx?: LogContext): void;
    info(msg: string, ctx?: LogContext): void;
    warn(msg: string, ctx?: LogContext): void;
    error(msg: string, ctx?: LogContext & {
        cause?: unknown;
    }): void;
    child(bind: LogContext): Logger;
    private _redactCtx;
}
//# sourceMappingURL=logger.d.ts.map