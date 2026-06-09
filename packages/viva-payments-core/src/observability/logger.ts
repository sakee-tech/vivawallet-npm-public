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

import { redact } from './redact.js';

// ---------------------------------------------------------------------------
// LogContext
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Logger interface
// ---------------------------------------------------------------------------

export interface Logger {
  debug(msg: string, ctx?: LogContext): void;
  info(msg: string, ctx?: LogContext): void;
  warn(msg: string, ctx?: LogContext): void;
  error(msg: string, ctx?: LogContext & { cause?: unknown }): void;
  /** Returns a new logger with these fields auto-merged into every log call. */
  child(bind: LogContext): Logger;
}

// ---------------------------------------------------------------------------
// No-op logger (for tests)
// ---------------------------------------------------------------------------

export class SilentLogger implements Logger {
  debug(_msg: string, _ctx?: LogContext): void {}
  info(_msg: string, _ctx?: LogContext): void {}
  warn(_msg: string, _ctx?: LogContext): void {}
  error(_msg: string, _ctx?: LogContext & { cause?: unknown }): void {}
  child(_bind: LogContext): Logger { return this; }
}

// ---------------------------------------------------------------------------
// Bigint-safe JSON serializer
// ---------------------------------------------------------------------------

function bigintSafeReplacer(_key: string, val: unknown): unknown {
  if (typeof val === 'bigint') return val.toString();
  if (val instanceof Error) {
    return {
      name: val.name,
      message: val.message,
      stack: val.stack?.slice(0, 2000),
    };
  }
  return val;
}

function serialize(obj: Record<string, unknown>): string {
  return JSON.stringify(obj, bigintSafeReplacer);
}

// ---------------------------------------------------------------------------
// StructuredJsonLogger
// ---------------------------------------------------------------------------

/**
 * Emits to stdout one JSON object per line.
 * Bigints → string. Errors → { name, message, stack }.
 */
export class StructuredJsonLogger implements Logger {
  private readonly _bound: LogContext;
  private readonly _out: (line: string) => void;

  constructor(opts?: { bound?: LogContext; out?: (line: string) => void }) {
    this._bound = opts?.bound ?? {};
    this._out = opts?.out ?? ((line) => process.stdout.write(line + '\n'));
  }

  debug(msg: string, ctx?: LogContext): void {
    this._emit('debug', msg, ctx);
  }

  info(msg: string, ctx?: LogContext): void {
    this._emit('info', msg, ctx);
  }

  warn(msg: string, ctx?: LogContext): void {
    this._emit('warn', msg, ctx);
  }

  error(msg: string, ctx?: LogContext & { cause?: unknown }): void {
    this._emit('error', msg, ctx);
  }

  child(bind: LogContext): Logger {
    return new StructuredJsonLogger({
      bound: { ...this._bound, ...bind },
      out: this._out,
    });
  }

  private _emit(level: string, msg: string, ctx?: LogContext & { cause?: unknown }): void {
    const { cause, ...rest } = ctx ?? {};
    const line: Record<string, unknown> = {
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

// ---------------------------------------------------------------------------
// RedactingLogger
// ---------------------------------------------------------------------------

/**
 * Wraps another logger; redacts known PCI fields from ctx.* before forwarding.
 */
export class RedactingLogger implements Logger {
  constructor(private readonly _inner: Logger) {}

  debug(msg: string, ctx?: LogContext): void {
    this._inner.debug(msg, this._redactCtx(ctx));
  }

  info(msg: string, ctx?: LogContext): void {
    this._inner.info(msg, this._redactCtx(ctx));
  }

  warn(msg: string, ctx?: LogContext): void {
    this._inner.warn(msg, this._redactCtx(ctx));
  }

  error(msg: string, ctx?: LogContext & { cause?: unknown }): void {
    this._inner.error(msg, this._redactCtx(ctx));
  }

  child(bind: LogContext): Logger {
    return new RedactingLogger(this._inner.child(this._redactCtx(bind) ?? {}));
  }

  private _redactCtx<C extends LogContext | undefined>(ctx: C): C {
    if (ctx === undefined) return ctx;
    return redact(ctx) as C;
  }
}
