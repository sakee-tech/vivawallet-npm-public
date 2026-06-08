"use strict";
/**
 * loaders/bootstrap.ts — Vendure plugin bootstrap warmup hook.
 *
 * Implements D12 from the plan: eager OAuth warm-up + undici Pool pre-connect
 * on application startup. Both warmups are best-effort:
 * - If Viva's token endpoint is unreachable the app still boots.
 * - A single retry is scheduled after BOOTSTRAP_RETRY_DELAY_MS (~10s).
 * - If the retry also fails the token cache stays empty; lazy-fetch in
 *   createPayment will obtain a token on the first real call.
 *
 * Logger: uses Vendure's static `Logger` so output is routed through whatever
 * VendureLogger the host app configures.
 *
 * @see docs/plans/vendure-plugin-v0.md §"Build Plan — V4" (D12)
 */
var __decorate = (this && this.__decorate) || function (decorators, target, key, desc) {
    var c = arguments.length, r = c < 3 ? target : desc === null ? desc = Object.getOwnPropertyDescriptor(target, key) : desc, d;
    if (typeof Reflect === "object" && typeof Reflect.decorate === "function") r = Reflect.decorate(decorators, target, key, desc);
    else for (var i = decorators.length - 1; i >= 0; i--) if (d = decorators[i]) r = (c < 3 ? d(r) : c > 3 ? d(target, key, r) : d(target, key)) || r;
    return c > 3 && r && Object.defineProperty(target, key, r), r;
};
var __metadata = (this && this.__metadata) || function (k, v) {
    if (typeof Reflect === "object" && typeof Reflect.metadata === "function") return Reflect.metadata(k, v);
};
var __param = (this && this.__param) || function (paramIndex, decorator) {
    return function (target, key) { decorator(target, key, paramIndex); }
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.VivaBootstrap = void 0;
const common_1 = require("@nestjs/common");
const core_1 = require("@vendure/core");
const auth_1 = require("@sakeetech/viva-payments-core/auth");
const constants_js_1 = require("../constants.js");
// ---------------------------------------------------------------------------
// Bootstrap service
// ---------------------------------------------------------------------------
let VivaBootstrap = class VivaBootstrap {
    options;
    oauth2;
    constructor(options, oauth2) {
        this.options = options;
        this.oauth2 = oauth2;
    }
    // Exposed for tests to read whether the last warmup succeeded.
    _lastWarmupFailed = false;
    get lastWarmupFailed() { return this._lastWarmupFailed; }
    async onApplicationBootstrap() {
        core_1.Logger.info('Starting Viva Wallet bootstrap warmup…', constants_js_1.VIVA_LOG_CONTEXT);
        await this._runWarmup(false);
    }
    // ---------------------------------------------------------------------------
    // Internal
    // ---------------------------------------------------------------------------
    async _runWarmup(isRetry) {
        const tag = isRetry ? '[retry] ' : '';
        try {
            // 1. Eager OAuth token fetch — warms the in-memory cache.
            await this.oauth2.getBearerToken();
            core_1.Logger.info(`${tag}Viva OAuth2 token cached successfully.`, constants_js_1.VIVA_LOG_CONTEXT);
            // 2. Pre-connect undici pools to both Viva hosts.
            //    Fire-and-forget: just accessing the pool initialises the connection.
            //    We don't need to do an actual HTTP request for the warmup.
            (0, auth_1.getAuthDispatcher)(this.options.environment);
            (0, auth_1.getApiDispatcher)(this.options.environment);
            core_1.Logger.info(`${tag}Viva undici pools pre-connected (env=${this.options.environment}).`, constants_js_1.VIVA_LOG_CONTEXT);
            this._lastWarmupFailed = false;
        }
        catch (err) {
            this._lastWarmupFailed = true;
            const msg = err instanceof Error ? err.message : String(err);
            if (isRetry) {
                // Retry also failed — leave cache empty, log warning, stop retrying.
                core_1.Logger.warn(`Viva bootstrap warmup retry failed: ${msg}. Token will be lazily fetched on first createPayment call.`, constants_js_1.VIVA_LOG_CONTEXT);
            }
            else {
                // First attempt failed — schedule one retry.
                core_1.Logger.warn(`Viva bootstrap warmup failed: ${msg}. Scheduling retry in ${constants_js_1.BOOTSTRAP_RETRY_DELAY_MS}ms.`, constants_js_1.VIVA_LOG_CONTEXT);
                setTimeout(() => {
                    void this._runWarmup(true);
                }, constants_js_1.BOOTSTRAP_RETRY_DELAY_MS);
            }
        }
    }
};
exports.VivaBootstrap = VivaBootstrap;
exports.VivaBootstrap = VivaBootstrap = __decorate([
    (0, common_1.Injectable)(),
    __param(0, (0, common_1.Inject)(constants_js_1.VIVA_PLUGIN_OPTIONS)),
    __param(1, (0, common_1.Inject)(constants_js_1.VIVA_OAUTH2_STRATEGY_TOKEN)),
    __metadata("design:paramtypes", [Object, Object])
], VivaBootstrap);
//# sourceMappingURL=bootstrap.js.map