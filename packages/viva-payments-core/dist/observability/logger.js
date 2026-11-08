"use strict";
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
Object.defineProperty(exports, "__esModule", { value: true });
exports.RedactingLogger = exports.StructuredJsonLogger = exports.SilentLogger = void 0;
const redact_js_1 = require("./redact.js");
// ---------------------------------------------------------------------------
// No-op logger (for tests)
// ---------------------------------------------------------------------------
class SilentLogger {
    debug(_msg, _ctx) { }
    info(_msg, _ctx) { }
    warn(_msg, _ctx) { }
    error(_msg, _ctx) { }
    child(_bind) { return this; }
}
exports.SilentLogger = SilentLogger;
// ---------------------------------------------------------------------------
// Bigint-safe JSON serializer
// ---------------------------------------------------------------------------
function bigintSafeReplacer(_key, val) {
    if (typeof val === 'bigint')
        return val.toString();
    if (val instanceof Error) {
        return {
            name: val.name,
            message: val.message,
            stack: val.stack?.slice(0, 2000),
        };
    }
    return val;
}
function serialize(obj) {
    return JSON.stringify(obj, bigintSafeReplacer);
}
// ---------------------------------------------------------------------------
// StructuredJsonLogger
// ---------------------------------------------------------------------------
/**
 * Emits to stdout one JSON object per line.
 * Bigints → string. Errors → { name, message, stack }.
 */
class StructuredJsonLogger {
    _bound;
    _out;
    constructor(opts) {
        this._bound = opts?.bound ?? {};
        this._out = opts?.out ?? ((line) => process.stdout.write(line + '\n'));
    }
    debug(msg, ctx) {
        this._emit('debug', msg, ctx);
    }
    info(msg, ctx) {
        this._emit('info', msg, ctx);
    }
    warn(msg, ctx) {
        this._emit('warn', msg, ctx);
    }
    error(msg, ctx) {
        this._emit('error', msg, ctx);
    }
    child(bind) {
        return new StructuredJsonLogger({
            bound: { ...this._bound, ...bind },
            out: this._out,
        });
    }
    _emit(level, msg, ctx) {
        const { cause, ...rest } = ctx ?? {};
        const line = {
            level,
            msg,
            time: new Date().toISOString(),
            ...this._bound,
            ...rest,
        };
        if (cause !== undefined) {
            line['cause'] = cause instanceof Error
                ? { name: cause.name, message: cause.message, stack: cause.stack?.slice(0, 2000) }
                : cause;
        }
        this._out(serialize(line));
    }
}
exports.StructuredJsonLogger = StructuredJsonLogger;
// ---------------------------------------------------------------------------
// RedactingLogger
// ---------------------------------------------------------------------------
/**
 * Wraps another logger; redacts known PCI fields from ctx.* before forwarding.
 */
class RedactingLogger {
    _inner;
    constructor(_inner) {
        this._inner = _inner;
    }
    debug(msg, ctx) {
        this._inner.debug(msg, this._redactCtx(ctx));
    }
    info(msg, ctx) {
        this._inner.info(msg, this._redactCtx(ctx));
    }
    warn(msg, ctx) {
        this._inner.warn(msg, this._redactCtx(ctx));
    }
    error(msg, ctx) {
        this._inner.error(msg, this._redactCtx(ctx));
    }
    child(bind) {
        return new RedactingLogger(this._inner.child(this._redactCtx(bind) ?? {}));
    }
    _redactCtx(ctx) {
        if (ctx === undefined)
            return ctx;
        return (0, redact_js_1.redact)(ctx);
    }
}
exports.RedactingLogger = RedactingLogger;
//# sourceMappingURL=logger.js.map