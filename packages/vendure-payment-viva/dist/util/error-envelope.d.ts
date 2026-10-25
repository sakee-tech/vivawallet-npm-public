/**
 * error-envelope.ts — VivaPluginError class for all plugin-level errors.
 *
 * One error class with static factories per error code.
 * Mirrors the §"Error Contract" section of docs/plans/vendure-plugin-v0.md.
 */
export type VivaErrorCode = 'VIVA_AUTH_DOWN' | 'VIVA_API_ERROR' | 'VIVA_ACCOUNT_NOT_VERIFIED' | 'VIVA_ISV_AMOUNT_TOO_HIGH' | 'VIVA_CHANNEL_MISCONFIGURED' | 'VIVA_ORDER_NOT_FOUND' | 'VIVA_AMOUNT_MISMATCH' | 'VIVA_REFUND_REJECTED' | 'VIVA_FAST_REFUND_INELIGIBLE' | 'VIVA_MODE_MISMATCH' | 'VIVA_PAYMENT_ALREADY_SETTLED' | 'VIVA_PAYMENT_NOT_CANCELLABLE' | 'VIVA_ALREADY_ONBOARDED' | 'VIVA_RESELLER_CREDENTIALS_MISSING' | 'VIVA_SOURCE_CREATION_FAILED' | 'VIVA_INTERNAL_ERROR';
export interface VivaPluginErrorOptions {
    code: VivaErrorCode;
    message: string;
    retryable: boolean;
    vivaErrorCode?: number;
    vivaErrorMessage?: string;
    cause?: unknown;
}
export declare class VivaPluginError extends Error {
    readonly code: VivaErrorCode;
    readonly retryable: boolean;
    readonly vivaErrorCode: number | undefined;
    readonly vivaErrorMessage: string | undefined;
    readonly cause: unknown;
    constructor(opts: VivaPluginErrorOptions);
    toJSON(): Record<string, unknown>;
    static authDown(message: string, cause?: unknown): VivaPluginError;
    static apiError(opts: {
        message: string;
        vivaErrorCode?: number;
        vivaErrorMessage?: string;
        cause?: unknown;
    }): VivaPluginError;
    static accountNotVerified(message?: string): VivaPluginError;
    static isvAmountTooHigh(isvAmount: number, amount: number): VivaPluginError;
    static channelMisconfigured(message?: string): VivaPluginError;
    static orderNotFound(message?: string): VivaPluginError;
    static amountMismatch(expected: bigint | number, actual: bigint | number): VivaPluginError;
    static refundRejected(message: string, cause?: unknown): VivaPluginError;
    static fastRefundIneligible(message?: string, cause?: unknown): VivaPluginError;
    static modeMismatch(message: string, cause?: unknown): VivaPluginError;
    static paymentAlreadySettled(): VivaPluginError;
    static paymentNotCancellable(reason?: string): VivaPluginError;
    static alreadyOnboarded(accountId: string): VivaPluginError;
    static resellerCredentialsMissing(message?: string): VivaPluginError;
    static sourceCreationFailed(opts: {
        message: string;
        vivaStatus?: number;
        vivaErrorCode?: number;
        cause?: unknown;
    }): VivaPluginError;
    static internalError(message: string, cause?: unknown): VivaPluginError;
}
//# sourceMappingURL=error-envelope.d.ts.map