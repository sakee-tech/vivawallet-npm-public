"use strict";
/**
 * viva-payments-core/errors — barrel export.
 *
 * Subpath: `viva-payments-core/errors`
 *
 * All error classes extend `VivaError`. Callers can do:
 *   import { VivaError, VivaAuthError, VivaRateLimitError } from 'viva-payments-core/errors';
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.VivaModeMismatchError = exports.VivaRateLimitError = exports.VivaWebhookError = exports.VivaValidationError = exports.VivaApiError = exports.VivaAuthError = exports.VivaError = void 0;
var base_js_1 = require("./base.js");
Object.defineProperty(exports, "VivaError", { enumerable: true, get: function () { return base_js_1.VivaError; } });
var auth_error_js_1 = require("./auth-error.js");
Object.defineProperty(exports, "VivaAuthError", { enumerable: true, get: function () { return auth_error_js_1.VivaAuthError; } });
var api_error_js_1 = require("./api-error.js");
Object.defineProperty(exports, "VivaApiError", { enumerable: true, get: function () { return api_error_js_1.VivaApiError; } });
var validation_error_js_1 = require("./validation-error.js");
Object.defineProperty(exports, "VivaValidationError", { enumerable: true, get: function () { return validation_error_js_1.VivaValidationError; } });
var webhook_error_js_1 = require("./webhook-error.js");
Object.defineProperty(exports, "VivaWebhookError", { enumerable: true, get: function () { return webhook_error_js_1.VivaWebhookError; } });
var rate_limit_error_js_1 = require("./rate-limit-error.js");
Object.defineProperty(exports, "VivaRateLimitError", { enumerable: true, get: function () { return rate_limit_error_js_1.VivaRateLimitError; } });
var mode_mismatch_error_js_1 = require("./mode-mismatch-error.js");
Object.defineProperty(exports, "VivaModeMismatchError", { enumerable: true, get: function () { return mode_mismatch_error_js_1.VivaModeMismatchError; } });
//# sourceMappingURL=index.js.map