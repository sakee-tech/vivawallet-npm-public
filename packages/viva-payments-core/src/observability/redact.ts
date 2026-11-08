/**
 * redact.ts — PCI field redaction for log contexts.
 *
 * Strips known cardholder-data fields from arbitrary objects before logging.
 * Uses a fixed allowlist — no heuristics.
 *
 * Redacted fields (case-sensitive): CardNumber, Cvc2, CardHolderName, Track2,
 * Pan, cardNumber, cvv, cvc, pan, track2, cardHolderName.
 *
 * @see references/viva-docs/md/webhooks-for-payments.txt:495 (PAN masking)
 */

// ---------------------------------------------------------------------------
// Redacted field names
// ---------------------------------------------------------------------------

const REDACTED_KEYS = new Set<string>([
  // Viva API / webhook names (PascalCase)
  'CardNumber',
  'Cvc2',
  'CardHolderName',
  'Track2',
  'Pan',
  // camelCase aliases
  'cardNumber',
  'cvv',
  'cvc',
  'pan',
  'track2',
  'cardHolderName',
]);

const REDACTED_SENTINEL = '<redacted>' as const;

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Recursively redacts PCI fields from an arbitrary value.
 *
 * - Replaces string/number values for known keys with `'<redacted>'`.
 * - Already-redacted sentinel values are left unchanged.
 * - Arrays are mapped element-by-element.
 * - Non-plain-object values (Date, null, primitives) are returned as-is.
 */
export function redact<T>(value: T): T {
  return _redact(value) as T;
}

/**
 * Replace identifiers in free text (e.g. Viva's `ErrorText`, which can name the
 * merchant or transaction) with `<id>`: UUIDs, and digit runs of 10+ (order
 * codes). Short numbers stay, so amounts, ErrorCodes and source codes survive.
 * Host rule: no identifiers in logs or errors.
 */
export function redactIds(text: string): string {
  return text.replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|\d{10,}/gi, '<id>');
}

/**
 * Log suffix for a Viva rejection: `" corr=<id>: <redacted reason>"`, or
 * `": <redacted reason>"` with no correlation id. `corr` is Viva's request
 * trace id (x-viva-correlationid, else the transport's requestId), not an
 * entity id, so it may be logged.
 */
export function describeVivaRejection(err: {
  message: string;
  vivaCorrelationId?: string | undefined;
  requestId?: string | undefined;
}): string {
  const corr = err.vivaCorrelationId ?? err.requestId;
  return `${corr ? ` corr=${corr}` : ''}: ${redactIds(err.message)}`;
}

function _redact(value: unknown): unknown {
  if (value === null || value === undefined) return value;
  if (typeof value !== 'object' && !Array.isArray(value)) return value;

  if (Array.isArray(value)) {
    return value.map(_redact);
  }

  if (typeof value === 'object') {
    // Skip non-plain objects (Date, Buffer, etc.)
    if (Object.prototype.toString.call(value) !== '[object Object]') return value;

    const src = value as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(src)) {
      if (REDACTED_KEYS.has(key)) {
        // Leave already-redacted sentinels unchanged
        out[key] = src[key] === REDACTED_SENTINEL ? REDACTED_SENTINEL : REDACTED_SENTINEL;
      } else {
        out[key] = _redact(src[key]);
      }
    }
    return out;
  }

  return value;
}
