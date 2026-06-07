/**
 * Abstract base class for all Viva Wallet errors.
 *
 * Every error carries a plugin-stable `code`, optional Viva API error code,
 * HTTP status, request correlation ID, and an ES2022-style `cause` chain.
 *
 * Subclasses implement `abstract readonly code: string` with a literal value.
 */
export class VivaError extends Error {
    /** Viva's own error code extracted from the response body, if available. */
    vivaCode;
    /** HTTP status from the Viva API response, if available. */
    httpStatus;
    /**
     * Viva `CorrelationId` response header, or a locally generated ID.
     * Use this for cross-system correlation when filing support tickets.
     */
    requestId;
    /**
     * Viva `x-viva-correlationid` response header value.
     * Probe-verified 2026-04-25: present on every Viva API response.
     * Example: "26-115-EDAA55BC". Use for end-to-end tracing + Viva support tickets.
     */
    vivaCorrelationId;
    /**
     * Viva `x-viva-eventid` response header value.
     * Probe-verified 2026-04-25: present on every Viva API response.
     * Example: "0".
     */
    vivaEventId;
    /** Chained cause per ES2022 Error.cause semantics. */
    cause;
    constructor({ message, vivaCode, httpStatus, requestId, vivaCorrelationId, vivaEventId, cause }) {
        super(message);
        // Ensure the prototype chain is correct for `instanceof` checks when
        // targeting ES5 or when transpiled.
        Object.setPrototypeOf(this, new.target.prototype);
        this.name = new.target.name;
        this.vivaCode = vivaCode;
        this.httpStatus = httpStatus;
        this.requestId = requestId;
        this.vivaCorrelationId = vivaCorrelationId;
        this.vivaEventId = vivaEventId;
        this.cause = cause;
        // V8 / Node.js: remove the constructor frame from the stack trace.
        if (Error.captureStackTrace) {
            Error.captureStackTrace(this, new.target);
        }
    }
}
//# sourceMappingURL=base.js.map