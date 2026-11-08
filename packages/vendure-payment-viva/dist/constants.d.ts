/**
 * constants.ts — Plugin-level constants and injection tokens.
 */
/** NestJS injection token for plugin options. */
export declare const VIVA_PLUGIN_OPTIONS = "VIVA_PLUGIN_OPTIONS";
/** Plugin name used for logging and NestJS module registration. */
export declare const VIVA_PLUGIN_NAME = "VivaPaymentPlugin";
/** Default Viva source code when none is configured per-channel. */
export declare const DEFAULT_SOURCE_CODE = "Default";
/** Default ISV platform fee (in minor units). 0 = no platform fee. */
export declare const DEFAULT_ISV_AMOUNT = 0;
/** Default webhook IP allowlist combining Viva's published demo + production CIDRs. */
export declare const DEFAULT_WEBHOOK_IP_ALLOWLIST: string[];
/** BullMQ queue name for webhook processing. */
export declare const VIVA_WEBHOOK_QUEUE = "viva-webhook";
/** BullMQ job name for processing a single webhook event. */
export declare const VIVA_WEBHOOK_JOB = "process-viva-webhook";
/**
 * BullMQ job name alias used by the webhook controller (V6) and webhook
 * worker handler (V7). Matches `VIVA_PROCESS_EVENT_JOB` in queue-names.ts.
 */
export declare const VIVA_PROCESS_EVENT_JOB = "process-viva-webhook";
/** Per-merchant semaphore max concurrency (matches Medusa A11). */
export declare const PER_MERCHANT_SEMAPHORE_PERMITS = 5;
/** Webhook event retention period in days. */
export declare const WEBHOOK_RETENTION_DAYS = 90;
/** OAuth token proactive-refresh margin in seconds (refresh 5 min before expiry). */
export declare const OAUTH_REFRESH_MARGIN_SECONDS = 300;
/** NestJS injection token for the singleton OAuth2 strategy. */
export declare const VIVA_OAUTH2_STRATEGY_TOKEN = "VIVA_OAUTH2_STRATEGY_TOKEN";
/** Vendure plugin name context string used in Logger calls. */
export declare const VIVA_LOG_CONTEXT = "VivaPaymentPlugin";
/** Bootstrap warmup: delay (ms) before the single retry attempt on failure. */
export declare const BOOTSTRAP_RETRY_DELAY_MS = 10000;
//# sourceMappingURL=constants.d.ts.map