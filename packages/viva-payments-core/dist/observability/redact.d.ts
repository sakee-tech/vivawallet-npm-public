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
//# sourceMappingURL=redact.d.ts.map