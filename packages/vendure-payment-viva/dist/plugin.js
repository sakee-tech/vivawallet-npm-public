"use strict";
/**
 * plugin.ts — VivaPaymentPlugin Vendure module.
 *
 * V4: wires entities, channel custom fields, OAuth2 singleton provider,
 * and the bootstrap warmup service. Payment handler, controllers, and
 * webhook job are wired in V5+.
 *
 * @see docs/plans/vendure-plugin-v0.md §D19, §"Build Plan (Waves) — V4"
 */
var __decorate = (this && this.__decorate) || function (decorators, target, key, desc) {
    var c = arguments.length, r = c < 3 ? target : desc === null ? desc = Object.getOwnPropertyDescriptor(target, key) : desc, d;
    if (typeof Reflect === "object" && typeof Reflect.decorate === "function") r = Reflect.decorate(decorators, target, key, desc);
    else for (var i = decorators.length - 1; i >= 0; i--) if (d = decorators[i]) r = (c < 3 ? d(r) : c > 3 ? d(target, key, r) : d(target, key)) || r;
    return c > 3 && r && Object.defineProperty(target, key, r), r;
};
var VivaPaymentPlugin_1;
Object.defineProperty(exports, "__esModule", { value: true });
exports.VivaPaymentPlugin = void 0;
const core_1 = require("@vendure/core");
const constants_js_1 = require("./constants.js");
const normalize_options_js_1 = require("./util/normalize-options.js");
const index_js_1 = require("./entities/index.js");
const viva_oauth2_strategy_provider_js_1 = require("./providers/viva-oauth2-strategy.provider.js");
const bootstrap_js_1 = require("./loaders/bootstrap.js");
const state_machine_service_js_1 = require("./services/state-machine.service.js");
const per_merchant_semaphore_service_js_1 = require("./services/per-merchant-semaphore.service.js");
const connected_accounts_service_js_1 = require("./services/connected-accounts.service.js");
const process_viva_webhook_handler_js_1 = require("./jobs/process-viva-webhook.handler.js");
const retention_cleanup_handler_js_1 = require("./jobs/retention-cleanup.handler.js");
const payment_method_handler_js_1 = require("./payment-method-handler.js");
const webhook_controller_js_1 = require("./api/webhook.controller.js");
const admin_onboarding_controller_js_1 = require("./api/admin-onboarding.controller.js");
const admin_internal_controller_js_1 = require("./api/admin-internal.controller.js");
const admin_sources_controller_js_1 = require("./api/admin-sources.controller.js");
const shop_api_resolver_js_1 = require("./api/shop-api.resolver.js");
const shop_api_extension_js_1 = require("./api/shop-api.extension.js");
const metrics_state_service_js_1 = require("./observability/metrics-state.service.js");
// ---------------------------------------------------------------------------
// Channel custom fields
// ---------------------------------------------------------------------------
/**
 * Channel-level custom fields auto-registered by the plugin.
 *
 * @see docs/plans/vendure-plugin-v0.md §"Data Model — Channel custom fields"
 *
 * v0.2.0 mode gating:
 *   - Always registered (both modes): `vivaSourceCode`, `vivaApplePayDomainVerified`.
 *   - Registered only when `options.mode === 'isv'`:
 *       `vivaAccountId`, `vivaMerchantId`, `vivaPayoutsEnabled`.
 *
 * NOTE on existing deployments switching merchant→isv or isv→merchant:
 *   Vendure does NOT auto-drop columns when a custom field is no longer
 *   registered (preserves operator data). Switching to merchant mode leaves
 *   the three ISV columns in place — unused but harmless. There is no data
 *   loss. To reclaim the columns, operators must drop them manually.
 *
 * Field visibility:
 * - `vivaPayoutsEnabled` is `public: true` — storefront reads it via Shop API
 *   to gate the Viva CTA.
 * - All other fields are admin-only (`public: false`).
 */
const ISV_ONLY_CHANNEL_FIELDS = [
    {
        name: 'vivaAccountId',
        type: 'string',
        nullable: true,
        public: false,
        ui: { component: 'text-form-input' },
        description: [{ languageCode: 'en', value: 'Viva accountId — written at onboarding-create' }],
    },
    {
        name: 'vivaMerchantId',
        type: 'string',
        nullable: true,
        public: false,
        ui: { component: 'text-form-input' },
        description: [{ languageCode: 'en', value: 'Viva merchantId UUID — written by plugin after Account Verification webhook' }],
    },
    {
        name: 'vivaPayoutsEnabled',
        type: 'boolean',
        nullable: false,
        defaultValue: false,
        public: true,
        description: [{ languageCode: 'en', value: 'Storefront gate: true once merchant is verified by Viva' }],
    },
];
const SHARED_CHANNEL_FIELDS = [
    {
        name: 'vivaSourceCode',
        type: 'string',
        nullable: true,
        defaultValue: 'Default',
        public: false,
        description: [{ languageCode: 'en', value: 'Viva source code for Smart Checkout — defaults to "Default"' }],
    },
    {
        name: 'vivaApplePayDomainVerified',
        type: 'boolean',
        nullable: false,
        defaultValue: false,
        public: false,
        description: [{ languageCode: 'en', value: 'Ops tracking: true once Apple Pay domain is verified (manual step)' }],
    },
];
/**
 * Resolve the channel custom fields to register based on the plugin mode.
 * Returns the merged + ordered list (matches v0.1.x ordering when mode='isv'
 * so existing snapshots / DB columns stay stable).
 */
function resolveChannelCustomFields(mode) {
    if (mode === 'isv') {
        // Order preserved from v0.1.x: accountId, merchantId, sourceCode, payoutsEnabled, applePayDomainVerified.
        const [accountId, merchantId, payoutsEnabled] = ISV_ONLY_CHANNEL_FIELDS;
        const [sourceCode, applePay] = SHARED_CHANNEL_FIELDS;
        return [accountId, merchantId, sourceCode, payoutsEnabled, applePay];
    }
    return [...SHARED_CHANNEL_FIELDS];
}
// ---------------------------------------------------------------------------
// Plugin-level module state
// ---------------------------------------------------------------------------
/**
 * Stored plugin options set by `.init()`.
 * Accessed at runtime by NestJS providers via the `VIVA_PLUGIN_OPTIONS` token.
 */
let pluginOptions;
// ---------------------------------------------------------------------------
// Plugin class
// ---------------------------------------------------------------------------
let VivaPaymentPlugin = VivaPaymentPlugin_1 = class VivaPaymentPlugin {
    /**
     * Configure and register the plugin.
     *
     * Must be called before passing the plugin to `VendureConfig.plugins`.
     *
     * @example
     * ```ts
     * VivaPaymentPlugin.init({
     *   mode: 'isv',
     *   clientId: process.env.VIVA_CLIENT_ID!,
     *   clientSecret: process.env.VIVA_CLIENT_SECRET!,
     *   environment: 'demo',
     *   webhookVerificationKey: process.env.VIVA_WEBHOOK_VERIFICATION_KEY!,
     *   successUrl: 'https://example.com/checkout/success?orderCode={orderCode}',
     *   failureUrl: 'https://example.com/checkout/failure',
     *   onboardingReturnUrl: 'https://example.com/admin/viva/onboarding-return',
     * })
     * ```
     *
     * Accepts either the new field names (`clientId`/`clientSecret`) or the
     * deprecated aliases (`isvClientId`/`isvClientSecret`) — old names emit a
     * one-time deprecation warning. `mode` is optional and defaults to
     * `'merchant'` (auto-detected as `'isv'` when ISV-only fields are present).
     */
    static init(options) {
        pluginOptions = (0, normalize_options_js_1.normalizePluginOptions)(options);
        return VivaPaymentPlugin_1;
    }
    /**
     * @internal Test-only: reset module-level init() warning flags.
     * Used by `test/plugin/init-validation.test.ts`.
     */
    static _resetInitNoticesForTesting() {
        (0, normalize_options_js_1._resetInitNoticesForTesting)();
    }
    /**
     * Exposes the channel custom field definitions for testing / inspection.
     * Mode-aware: returns the fields registered for the current init() mode.
     * Falls back to the ISV field set when init() hasn't been called yet so
     * existing snapshot tests continue to see the full list by default.
     * @internal
     */
    static get channelCustomFields() {
        const mode = pluginOptions?.mode ?? 'isv';
        return resolveChannelCustomFields(mode);
    }
};
exports.VivaPaymentPlugin = VivaPaymentPlugin;
exports.VivaPaymentPlugin = VivaPaymentPlugin = VivaPaymentPlugin_1 = __decorate([
    (0, core_1.VendurePlugin)({
        // PluginCommonModule exposes Vendure core providers (TransactionalConnection,
        // OrderService, PaymentService, …) to this plugin's injector scope. Required
        // because several of our providers/controllers inject them (StateMachineService,
        // ConnectedAccountsService, webhook handler, resolver). Without it NestJS cannot
        // resolve those deps and the server crashes on bootstrap.
        imports: [core_1.PluginCommonModule],
        controllers: [webhook_controller_js_1.WebhookController, admin_onboarding_controller_js_1.AdminOnboardingController, admin_internal_controller_js_1.AdminInternalController, admin_sources_controller_js_1.AdminSourcesController],
        shopApiExtensions: {
            schema: shop_api_extension_js_1.shopApiExtensions,
            resolvers: [shop_api_resolver_js_1.VivaShopApiResolver],
        },
        providers: [
            // Options factory — must come first so other providers can inject it.
            {
                provide: constants_js_1.VIVA_PLUGIN_OPTIONS,
                useFactory: () => {
                    if (!pluginOptions) {
                        throw new Error(`[${constants_js_1.VIVA_PLUGIN_NAME}] Plugin options not initialised. Call VivaPaymentPlugin.init(options) before adding the plugin to your VendureConfig.`);
                    }
                    return pluginOptions;
                },
            },
            // Singleton OAuth2 strategy — depends on VIVA_PLUGIN_OPTIONS.
            viva_oauth2_strategy_provider_js_1.VivaOAuth2StrategyProvider,
            // Bootstrap warmup hook — depends on both of the above.
            bootstrap_js_1.VivaBootstrap,
            // Row-level transaction helpers + order/payment transitions (V5 + V7).
            state_machine_service_js_1.StateMachineService,
            // Per-merchant in-process semaphore (V7, D9).
            per_merchant_semaphore_service_js_1.PerMerchantSemaphore,
            // Channel ↔ Viva account helpers (V7 + V9).
            connected_accounts_service_js_1.ConnectedAccountsService,
            // Webhook worker job handler — registers queue on bootstrap (V7).
            process_viva_webhook_handler_js_1.ProcessVivaWebhookHandler,
            // 90-day webhook event retention cleanup — daily setInterval (V7).
            retention_cleanup_handler_js_1.RetentionCleanupHandler,
            // Shop API mutation resolver — cancelPayment (V8).
            shop_api_resolver_js_1.VivaShopApiResolver,
            // In-process metrics state singleton (V10).
            metrics_state_service_js_1.MetricsStateService,
        ],
        entities: [index_js_1.VivaTransaction, index_js_1.VivaWebhookEvent],
        exports: [constants_js_1.VIVA_PLUGIN_OPTIONS, bootstrap_js_1.VivaBootstrap, state_machine_service_js_1.StateMachineService, per_merchant_semaphore_service_js_1.PerMerchantSemaphore, connected_accounts_service_js_1.ConnectedAccountsService, process_viva_webhook_handler_js_1.ProcessVivaWebhookHandler, metrics_state_service_js_1.MetricsStateService],
        compatibility: '^3.0.0',
        configuration: (config) => {
            // Merge Viva channel custom fields into the host app's customFields config.
            // Vendure handles the column migrations automatically.
            //
            // ISV-only fields (vivaAccountId, vivaMerchantId, vivaPayoutsEnabled) are
            // skipped in merchant mode — see resolveChannelCustomFields above.
            const mode = pluginOptions?.mode ?? 'merchant';
            const channelFields = resolveChannelCustomFields(mode);
            config.customFields.Channel = [
                ...(config.customFields.Channel ?? []),
                ...channelFields,
            ];
            // Register the Viva payment method handler.
            config.paymentOptions = config.paymentOptions ?? {};
            config.paymentOptions.paymentMethodHandlers = [
                ...(config.paymentOptions.paymentMethodHandlers ?? []),
                payment_method_handler_js_1.vivaPaymentMethodHandler,
            ];
            return config;
        },
    })
], VivaPaymentPlugin);
//# sourceMappingURL=plugin.js.map