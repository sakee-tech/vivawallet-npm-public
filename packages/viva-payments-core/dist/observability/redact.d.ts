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
/**
 * Recursively redacts PCI fields from an arbitrary value.
 *
 * - Replaces string/number values for known keys with `'<redacted>'`.
 * - Already-redacted sentinel values are left unchanged.
 * - Arrays are mapped element-by-element.
 * - Non-plain-object values (Date, null, primitives) are returned as-is.
 */
export declare function redact<T>(value: T): T;
/**
 * Replace identifiers in free text (e.g. Viva's `ErrorText`, which can name the
 * merchant or transaction) with `<id>`: UUIDs, and digit runs of 10+ (order
 * codes). Short numbers stay, so amounts, ErrorCodes and source codes survive.
 * Host rule: no identifiers in logs or errors.
 */
export declare function redactIds(text: string): string;
/**
 * Log suffix for a Viva rejection: `" corr=<id>: <redacted reason>"`, or
 * `": <redacted reason>"` with no correlation id. `corr` is Viva's request
 * trace id (x-viva-correlationid, else the transport's requestId), not an
 * entity id, so it may be logged.
 */
export declare function describeVivaRejection(err: {
    message: string;
    vivaCorrelationId?: string | undefined;
    requestId?: string | undefined;
}): string;
//# sourceMappingURL=redact.d.ts.map