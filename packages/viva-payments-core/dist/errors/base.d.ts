/**
 * Abstract base class for all Viva Wallet errors.
 *
 * Every error carries a plugin-stable `code`, optional Viva API error code,
 * HTTP status, request correlation ID, and an ES2022-style `cause` chain.
 *
 * Subclasses implement `abstract readonly code: string` with a literal value.
 */
export interface VivaErrorOptions {
    message: string;
    vivaCode?: string | undefined;
    httpStatus?: number | undefined;
    requestId?: string | undefined;
    /**
     * Viva `x-viva-correlationid` response header value.
     * Probe-verified 2026-04-25: present on every Viva API response.
     * Example: "26-115-EDAA55BC". Use for end-to-end tracing + Viva support tickets.
     */
    vivaCorrelationId?: string | undefined;
    /**
     * Viva `x-viva-eventid` response header value.
     * Probe-verified 2026-04-25: present on every Viva API response.
     * Example: "0".
     */
    vivaEventId?: string | undefined;
    cause?: unknown;
}
export declare abstract class VivaError extends Error {
    /**
     * Plugin-stable string identifier for the error type.
     * Consumers use this for programmatic branching — never match on `message`.
     */
    abstract readonly code: string;
    /** Viva's own error code extracted from the response body, if available. */
    readonly vivaCode: string | undefined;
    /** HTTP status from the Viva API response, if available. */
    readonly httpStatus: number | undefined;
    /**
     * Viva `CorrelationId` response header, or a locally generated ID.
     * Use this for cross-system correlation when filing support tickets.
     */
    readonly requestId: string | undefined;
    /**
     * Viva `x-viva-correlationid` response header value.
     * Probe-verified 2026-04-25: present on every Viva API response.
     * Example: "26-115-EDAA55BC". Use for end-to-end tracing + Viva support tickets.
     */
    readonly vivaCorrelationId: string | undefined;
    /**
     * Viva `x-viva-eventid` response header value.
     * Probe-verified 2026-04-25: present on every Viva API response.
     * Example: "0".
     */
    readonly vivaEventId: string | undefined;
    /** Chained cause per ES2022 Error.cause semantics. */
    readonly cause: unknown;
    constructor({ message, vivaCode, httpStatus, requestId, vivaCorrelationId, vivaEventId, cause }: VivaErrorOptions);
}
//# sourceMappingURL=base.d.ts.map