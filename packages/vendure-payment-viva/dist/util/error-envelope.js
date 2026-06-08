"use strict";
/**
 * error-envelope.ts — VivaPluginError class for all plugin-level errors.
 *
 * One error class with static factories per error code.
 * Mirrors the §"Error Contract" section of docs/plans/vendure-plugin-v0.md.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.VivaPluginError = void 0;
class VivaPluginError extends Error {
    code;
    retryable;
    vivaErrorCode;
    vivaErrorMessage;
    cause;
    constructor(opts) {
        super(opts.message);
        Object.setPrototypeOf(this, new.target.prototype);
        this.name = 'VivaPluginError';
        this.code = opts.code;
        this.retryable = opts.retryable;
        this.vivaErrorCode = opts.vivaErrorCode;
        this.vivaErrorMessage = opts.vivaErrorMessage;
        this.cause = opts.cause;
        if (Error.captureStackTrace) {
            Error.captureStackTrace(this, new.target);
        }
    }
    toJSON() {
        return {
            code: this.code,
            message: this.message,
            retryable: this.retryable,
            ...(this.vivaErrorCode !== undefined ? { vivaErrorCode: this.vivaErrorCode } : {}),
            ...(this.vivaErrorMessage !== undefined ? { vivaErrorMessage: this.vivaErrorMessage } : {}),
        };
    }
    // ---------------------------------------------------------------------------
    // Static factories
    // ---------------------------------------------------------------------------
    static authDown(message, cause) {
        return new VivaPluginError({ code: 'VIVA_AUTH_DOWN', message, retryable: true, cause });
    }
    static apiError(opts) {
        const o = {
            code: 'VIVA_API_ERROR',
            message: opts.message,
            retryable: false,
        };
        if (opts.vivaErrorCode !== undefined)
            o.vivaErrorCode = opts.vivaErrorCode;
        if (opts.vivaErrorMessage !== undefined)
            o.vivaErrorMessage = opts.vivaErrorMessage;
        if (opts.cause !== undefined)
            o.cause = opts.cause;
        return new VivaPluginError(o);
    }
    static accountNotVerified(message) {
        return new VivaPluginError({
            code: 'VIVA_ACCOUNT_NOT_VERIFIED',
            message: message ?? 'Viva payouts not enabled for this channel. Complete merchant verification first.',
            retryable: false,
        });
    }
    static isvAmountTooHigh(isvAmount, amount) {
        return new VivaPluginError({
            code: 'VIVA_ISV_AMOUNT_TOO_HIGH',
            message: `ISV amount (${isvAmount}) must be strictly less than order amount (${amount}).`,
            retryable: false,
        });
    }
    static channelMisconfigured(message) {
        return new VivaPluginError({
            code: 'VIVA_CHANNEL_MISCONFIGURED',
            message: message ?? 'Channel is missing vivaMerchantId configuration.',
            retryable: false,
        });
    }
    static orderNotFound(message) {
        return new VivaPluginError({
            code: 'VIVA_ORDER_NOT_FOUND',
            message: message ?? 'Viva order or transaction not found.',
            retryable: false,
        });
    }
    static amountMismatch(expected, actual) {
        return new VivaPluginError({
            code: 'VIVA_AMOUNT_MISMATCH',
            message: `Amount mismatch: expected ${expected}, got ${actual} from Viva.`,
            retryable: false,
        });
    }
    static refundRejected(message, cause) {
        return new VivaPluginError({ code: 'VIVA_REFUND_REJECTED', message, retryable: false, cause });
    }
    static fastRefundIneligible(message, cause) {
        return new VivaPluginError({
            code: 'VIVA_FAST_REFUND_INELIGIBLE',
            message: message ??
                "Fast Refund ineligible (HTTP 403). Configured strategy 'fast' does not fall back. " +
                    "Set refundStrategy='auto' to enable automatic Standard-refund fallback.",
            retryable: false,
            cause,
        });
    }
    static modeMismatch(message, cause) {
        return new VivaPluginError({
            code: 'VIVA_MODE_MISMATCH',
            message,
            retryable: false,
            cause,
        });
    }
    static paymentAlreadySettled() {
        return new VivaPluginError({
            code: 'VIVA_PAYMENT_ALREADY_SETTLED',
            message: 'Payment is already settled.',
            retryable: false,
        });
    }
    static paymentNotCancellable(reason) {
        return new VivaPluginError({
            code: 'VIVA_PAYMENT_NOT_CANCELLABLE',
            message: reason ?? 'Payment cannot be cancelled in its current state.',
            retryable: false,
        });
    }
    static alreadyOnboarded(accountId) {
        return new VivaPluginError({
            code: 'VIVA_ALREADY_ONBOARDED',
            message: `Channel already has accountId ${accountId}. Use the reconcile endpoint to refresh.`,
            retryable: false,
        });
    }
    static resellerCredentialsMissing(message) {
        return new VivaPluginError({
            code: 'VIVA_RESELLER_CREDENTIALS_MISSING',
            message: message ??
                'POST /viva/admin/connected-accounts/:id/sources requires reseller credentials. ' +
                    'Set options.reseller = { resellerId, merchantId, resellerApiKey } in VivaPaymentPlugin.init().',
            retryable: false,
        });
    }
    static sourceCreationFailed(opts) {
        const o = {
            code: 'VIVA_SOURCE_CREATION_FAILED',
            message: opts.message,
            retryable: false,
        };
        if (opts.vivaErrorCode !== undefined)
            o.vivaErrorCode = opts.vivaErrorCode;
        if (opts.cause !== undefined)
            o.cause = opts.cause;
        return new VivaPluginError(o);
    }
    static internalError(message, cause) {
        return new VivaPluginError({ code: 'VIVA_INTERNAL_ERROR', message, retryable: false, cause });
    }
}
exports.VivaPluginError = VivaPluginError;
//# sourceMappingURL=error-envelope.js.map