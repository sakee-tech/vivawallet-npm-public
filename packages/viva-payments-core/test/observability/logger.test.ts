/**
 * logger.test.ts — StructuredJsonLogger and RedactingLogger unit tests.
 */

import { describe, it, expect } from 'vitest';
import { StructuredJsonLogger, RedactingLogger } from '../../src/observability/logger.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function captureLines(fn: (logger: StructuredJsonLogger) => void): string[] {
  const lines: string[] = [];
  const logger = new StructuredJsonLogger({
    out: (line) => lines.push(line),
  });
  fn(logger);
  return lines;
}

function parseLine(line: string): Record<string, unknown> {
  return JSON.parse(line) as Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// StructuredJsonLogger
// ---------------------------------------------------------------------------

describe('StructuredJsonLogger', () => {
  it('emits valid JSON with level, msg, time fields', () => {
    const lines = captureLines((l) => l.info('hello world', { tenant_id: 'tenant-1' }));
    expect(lines).toHaveLength(1);
    const obj = parseLine(lines[0]!);
    expect(obj.level).toBe('info');
    expect(obj.msg).toBe('hello world');
    expect(typeof obj.time).toBe('string');
    expect(new Date(obj.time as string).getTime()).toBeGreaterThan(0);
    expect(obj.tenant_id).toBe('tenant-1');
  });

  it('includes all LogContext fields in JSON output', () => {
    const lines = captureLines((l) =>
      l.warn('ctx test', {
        trace_id: 'trace-abc',
        tenant_id: 'tenant-2',
        viva_merchant_id: 'merch-1',
        viva_order_code: '12345678901234',
        viva_transaction_id: 'txn-uuid',
        event_type_id: 1796,
      }),
    );
    const obj = parseLine(lines[0]!);
    expect(obj.trace_id).toBe('trace-abc');
    expect(obj.viva_order_code).toBe('12345678901234');
    expect(obj.event_type_id).toBe(1796);
  });

  it('serializes bigint values as strings', () => {
    const lines = captureLines((l) => l.info('bigint test', { bigval: BigInt('9007199254740993') as unknown as string }));
    const obj = parseLine(lines[0]!);
    expect(obj.bigval).toBe('9007199254740993');
  });

  it('child() accumulates context into every subsequent log call', () => {
    const lines: string[] = [];
    const root = new StructuredJsonLogger({ out: (l) => lines.push(l) });
    const child = root.child({ tenant_id: 'child-tenant' });
    child.info('child message', { trace_id: 'trace-x' });
    const obj = parseLine(lines[0]!);
    expect(obj.tenant_id).toBe('child-tenant');
    expect(obj.trace_id).toBe('trace-x');
  });

  it('child context is overridden by per-call ctx', () => {
    const lines: string[] = [];
    const root = new StructuredJsonLogger({ out: (l) => lines.push(l) });
    const child = root.child({ tenant_id: 'original' });
    child.info('override', { tenant_id: 'overridden' });
    const obj = parseLine(lines[0]!);
    expect(obj.tenant_id).toBe('overridden');
  });

  it('error serializes Error cause with name, message, stack', () => {
    const lines = captureLines((l) =>
      l.error('something failed', { cause: new Error('root cause') }),
    );
    const obj = parseLine(lines[0]!);
    const cause = obj.cause as Record<string, unknown>;
    expect(cause.name).toBe('Error');
    expect(cause.message).toBe('root cause');
    expect(typeof cause.stack).toBe('string');
  });

  it('stack is truncated to 2000 characters', () => {
    const err = new Error('long stack');
    // Inject very long stack
    err.stack = 'Error: long stack\n' + 'x'.repeat(3000);
    const lines = captureLines((l) => l.error('test', { cause: err }));
    const obj = parseLine(lines[0]!);
    const cause = obj.cause as Record<string, unknown>;
    expect((cause.stack as string).length).toBeLessThanOrEqual(2000);
  });
});

// ---------------------------------------------------------------------------
// RedactingLogger
// ---------------------------------------------------------------------------

describe('RedactingLogger', () => {
  function makeRedactingLogger(): { logger: RedactingLogger; lines: string[] } {
    const lines: string[] = [];
    const inner = new StructuredJsonLogger({ out: (l) => lines.push(l) });
    return { logger: new RedactingLogger(inner), lines };
  }

  it('redacts CardNumber from context', () => {
    const { logger, lines } = makeRedactingLogger();
    logger.info('card event', { CardNumber: '4111111111111111' } as never);
    const obj = parseLine(lines[0]!);
    expect(obj.CardNumber).toBe('<redacted>');
  });

  it('does not redact non-PCI keys', () => {
    const { logger, lines } = makeRedactingLogger();
    logger.info('ok event', { tenant_id: 'tenant-safe', amount: 1000 } as never);
    const obj = parseLine(lines[0]!);
    expect(obj.tenant_id).toBe('tenant-safe');
    expect(obj.amount).toBe(1000);
  });

  it('child inherits redaction', () => {
    const { logger, lines } = makeRedactingLogger();
    const child = logger.child({ tenant_id: 'tenant-child' });
    child.info('nested', { CardNumber: '4242424242424242' } as never);
    const obj = parseLine(lines[0]!);
    expect(obj.CardNumber).toBe('<redacted>');
    expect(obj.tenant_id).toBe('tenant-child');
  });
});
