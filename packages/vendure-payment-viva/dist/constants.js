"use strict";
/**
 * constants.ts — Plugin-level constants and injection tokens.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.BOOTSTRAP_RETRY_DELAY_MS = exports.VIVA_LOG_CONTEXT = exports.VIVA_OAUTH2_STRATEGY_TOKEN = exports.OAUTH_REFRESH_MARGIN_SECONDS = exports.WEBHOOK_RETENTION_DAYS = exports.PER_MERCHANT_SEMAPHORE_PERMITS = exports.VIVA_PROCESS_EVENT_JOB = exports.VIVA_WEBHOOK_JOB = exports.VIVA_WEBHOOK_QUEUE = exports.DEFAULT_WEBHOOK_IP_ALLOWLIST = exports.DEFAULT_ISV_AMOUNT = exports.DEFAULT_SOURCE_CODE = exports.VIVA_PLUGIN_NAME = exports.VIVA_PLUGIN_OPTIONS = void 0;
/** NestJS injection token for plugin options. */
exports.VIVA_PLUGIN_OPTIONS = 'VIVA_PLUGIN_OPTIONS';
/** Plugin name used for logging and NestJS module registration. */
exports.VIVA_PLUGIN_NAME = 'VivaPaymentPlugin';
/** Default Viva source code when none is configured per-channel. */
exports.DEFAULT_SOURCE_CODE = 'Default';
/** Default ISV platform fee (in minor units). 0 = no platform fee. */
exports.DEFAULT_ISV_AMOUNT = 0;
/** Default webhook IP allowlist combining Viva's published demo + production CIDRs. */
exports.DEFAULT_WEBHOOK_IP_ALLOWLIST = [
    // Viva demo environment
    '91.220.45.0/24',
    // Viva production environment
    '87.202.152.0/22',
];
/** BullMQ queue name for webhook processing. */
exports.VIVA_WEBHOOK_QUEUE = 'viva-webhook';
/** BullMQ job name for processing a single webhook event. */
exports.VIVA_WEBHOOK_JOB = 'process-viva-webhook';
/**
 * BullMQ job name alias used by the webhook controller (V6) and webhook
 * worker handler (V7). Matches `VIVA_PROCESS_EVENT_JOB` in queue-names.ts.
 */
exports.VIVA_PROCESS_EVENT_JOB = exports.VIVA_WEBHOOK_JOB;
/** Per-merchant semaphore max concurrency (matches Medusa A11). */
exports.PER_MERCHANT_SEMAPHORE_PERMITS = 5;
/** Webhook event retention period in days. */
exports.WEBHOOK_RETENTION_DAYS = 90;
/** OAuth token proactive-refresh margin in seconds (refresh 5 min before expiry). */
exports.OAUTH_REFRESH_MARGIN_SECONDS = 300;
/** NestJS injection token for the singleton OAuth2 strategy. */
exports.VIVA_OAUTH2_STRATEGY_TOKEN = 'VIVA_OAUTH2_STRATEGY_TOKEN';
/** Vendure plugin name context string used in Logger calls. */
exports.VIVA_LOG_CONTEXT = 'VivaPaymentPlugin';
/** Bootstrap warmup: delay (ms) before the single retry attempt on failure. */
exports.BOOTSTRAP_RETRY_DELAY_MS = 10_000;
//# sourceMappingURL=constants.js.map