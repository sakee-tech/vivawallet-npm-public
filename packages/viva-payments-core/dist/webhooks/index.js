"use strict";
/**
 * viva-payments-core/webhooks — barrel export.
 *
 * Provides two security layers for the Viva webhook endpoint:
 *   (a) IP allowlist         — isAllowedSourceIp()
 *   (b) Challenge-response   — buildChallengeResponse()
 *
 * Viva does not sign payment webhooks (no HMAC, no body signing); auth is the
 * IP allowlist plus the URL-verification handshake.
 *
 * Plus runtime helpers for event types and the monotonic status lattice.
 *
 * @see references/viva-docs/md/webhooks-for-payments.txt:254
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.applyStatusTransition = exports.validateStatusTransition = exports.mapStatusLetter = exports.ISV_EVENT_TYPE_IDS = exports.V1_EVENT_TYPE_IDS = exports.isOnboardingEvent = exports.isTransactionEvent = exports.EVENT_TYPES = exports.extractClientIp = exports.isAllowedSourceIp = exports.VIVA_PROD_IPS = exports.VIVA_DEMO_IPS = exports.buildChallengeResponse = void 0;
var challenge_response_js_1 = require("./challenge-response.js");
Object.defineProperty(exports, "buildChallengeResponse", { enumerable: true, get: function () { return challenge_response_js_1.buildChallengeResponse; } });
var ip_allowlist_js_1 = require("./ip-allowlist.js");
Object.defineProperty(exports, "VIVA_DEMO_IPS", { enumerable: true, get: function () { return ip_allowlist_js_1.VIVA_DEMO_IPS; } });
Object.defineProperty(exports, "VIVA_PROD_IPS", { enumerable: true, get: function () { return ip_allowlist_js_1.VIVA_PROD_IPS; } });
Object.defineProperty(exports, "isAllowedSourceIp", { enumerable: true, get: function () { return ip_allowlist_js_1.isAllowedSourceIp; } });
var extract_client_ip_js_1 = require("./extract-client-ip.js");
Object.defineProperty(exports, "extractClientIp", { enumerable: true, get: function () { return extract_client_ip_js_1.extractClientIp; } });
var event_types_js_1 = require("./event-types.js");
Object.defineProperty(exports, "EVENT_TYPES", { enumerable: true, get: function () { return event_types_js_1.EVENT_TYPES; } });
Object.defineProperty(exports, "isTransactionEvent", { enumerable: true, get: function () { return event_types_js_1.isTransactionEvent; } });
Object.defineProperty(exports, "isOnboardingEvent", { enumerable: true, get: function () { return event_types_js_1.isOnboardingEvent; } });
Object.defineProperty(exports, "V1_EVENT_TYPE_IDS", { enumerable: true, get: function () { return event_types_js_1.V1_EVENT_TYPE_IDS; } });
Object.defineProperty(exports, "ISV_EVENT_TYPE_IDS", { enumerable: true, get: function () { return event_types_js_1.ISV_EVENT_TYPE_IDS; } });
var status_lattice_js_1 = require("./status-lattice.js");
Object.defineProperty(exports, "mapStatusLetter", { enumerable: true, get: function () { return status_lattice_js_1.mapStatusLetter; } });
Object.defineProperty(exports, "validateStatusTransition", { enumerable: true, get: function () { return status_lattice_js_1.validateStatusTransition; } });
Object.defineProperty(exports, "applyStatusTransition", { enumerable: true, get: function () { return status_lattice_js_1.applyStatusTransition; } });
//# sourceMappingURL=index.js.map