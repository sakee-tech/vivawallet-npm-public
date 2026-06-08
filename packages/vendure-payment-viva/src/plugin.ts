/**
 * plugin.ts — VivaPaymentPlugin Vendure module.
 *
 * V4: wires entities, channel custom fields, OAuth2 singleton provider,
 * and the bootstrap warmup service. Payment handler, controllers, and
 * webhook job are wired in V5+.
 *
 * @see docs/plans/vendure-plugin-v0.md §D19, §"Build Plan (Waves) — V4"
 */

import { VendurePlugin, PluginCommonModule } from '@vendure/core';
import type { RuntimeVendureConfig } from '@vendure/core';
import { VIVA_PLUGIN_OPTIONS, VIVA_PLUGIN_NAME } from './constants.js';
import type {
  VivaPaymentPluginOptions,
  VivaPaymentPluginInitInput,
} from './types.js';
import { normalizePluginOptions, _resetInitNoticesForTesting } from './util/normalize-options.js';
import { VivaTransaction, VivaWebhookEvent } from './entities/index.js';
import { VivaOAuth2StrategyProvider } from './providers/viva-oauth2-strategy.provider.js';
import { VivaBootstrap } from './loaders/bootstrap.js';
import { StateMachineService } from './services/state-machine.service.js';
import { PerMerchantSemaphore } from './services/per-merchant-semaphore.service.js';
import { ConnectedAccountsService } from './services/connected-accounts.service.js';
import { ProcessVivaWebhookHandler } from './jobs/process-viva-webhook.handler.js';
import { RetentionCleanupHandler } from './jobs/retention-cleanup.handler.js';
import { vivaPaymentMethodHandler } from './payment-method-handler.js';
import { vivaPaymentProcess } from './payment-process.js';
import { WebhookController } from './api/webhook.controller.js';
import { AdminOnboardingController } from './api/admin-onboarding.controller.js';
import { AdminInternalController } from './api/admin-internal.controller.js';
import { AdminSourcesController } from './api/admin-sources.controller.js';
import { VivaShopApiResolver } from './api/shop-api.resolver.js';
import { shopApiExtensions } from './api/shop-api.extension.js';
import { MetricsStateService } from './observability/metrics-state.service.js';

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
    type: 'string' as const,
    nullable: true,
    public: false,
    ui: { component: 'text-form-input' },
    description: [{ languageCode: 'en' as any, value: 'Viva accountId — written at onboarding-create' }],
  },
  {
    name: 'vivaMerchantId',
    type: 'string' as const,
    nullable: true,
    public: false,
    ui: { component: 'text-form-input' },
    description: [{ languageCode: 'en' as any, value: 'Viva merchantId UUID — written by plugin after Account Verification webhook' }],
  },
  {
    name: 'vivaPayoutsEnabled',
    type: 'boolean' as const,
    nullable: false,
    defaultValue: false,
    public: true,
    description: [{ languageCode: 'en' as any, value: 'Storefront gate: true once merchant is verified by Viva' }],
  },
];

const SHARED_CHANNEL_FIELDS = [
  {
    name: 'vivaSourceCode',
    type: 'string' as const,
    nullable: true,
    defaultValue: 'Default',
    public: false,
    description: [{ languageCode: 'en' as any, value: 'Viva source code for Smart Checkout — defaults to "Default"' }],
  },
  {
    name: 'vivaApplePayDomainVerified',
    type: 'boolean' as const,
    nullable: false,
    defaultValue: false,
    public: false,
    description: [{ languageCode: 'en' as any, value: 'Ops tracking: true once Apple Pay domain is verified (manual step)' }],
  },
];

/**
 * Resolve the channel custom fields to register based on the plugin mode.
 * Returns the merged + ordered list (matches v0.1.x ordering when mode='isv'
 * so existing snapshots / DB columns stay stable).
 */
function resolveChannelCustomFields(mode: 'merchant' | 'isv'): Array<typeof ISV_ONLY_CHANNEL_FIELDS[number] | typeof SHARED_CHANNEL_FIELDS[number]> {
  if (mode === 'isv') {
    // Order preserved from v0.1.x: accountId, merchantId, sourceCode, payoutsEnabled, applePayDomainVerified.
    const [accountId, merchantId, payoutsEnabled] = ISV_ONLY_CHANNEL_FIELDS;
    const [sourceCode, applePay] = SHARED_CHANNEL_FIELDS;
    return [accountId!, merchantId!, sourceCode!, payoutsEnabled!, applePay!];
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
let pluginOptions: VivaPaymentPluginOptions | undefined;

// ---------------------------------------------------------------------------
// Plugin class
// ---------------------------------------------------------------------------

@VendurePlugin({
  // PluginCommonModule exposes Vendure core providers (TransactionalConnection,
  // OrderService, PaymentService, …) to this plugin's injector scope. Required
  // because several of our providers/controllers inject them (StateMachineService,
  // ConnectedAccountsService, webhook handler, resolver). Without it NestJS cannot
  // resolve those deps and the server crashes on bootstrap.
  imports: [PluginCommonModule],
  controllers: [WebhookController, AdminOnboardingController, AdminInternalController, AdminSourcesController],
  shopApiExtensions: {
    schema: shopApiExtensions,
    resolvers: [VivaShopApiResolver],
  },
  providers: [
    // Options factory — must come first so other providers can inject it.
    {
      provide: VIVA_PLUGIN_OPTIONS,
      useFactory: (): VivaPaymentPluginOptions => {
        if (!pluginOptions) {
          throw new Error(
            `[${VIVA_PLUGIN_NAME}] Plugin options not initialised. Call VivaPaymentPlugin.init(options) before adding the plugin to your VendureConfig.`,
          );
        }
        return pluginOptions;
      },
    },
    // Singleton OAuth2 strategy — depends on VIVA_PLUGIN_OPTIONS.
    VivaOAuth2StrategyProvider,
    // Bootstrap warmup hook — depends on both of the above.
    VivaBootstrap,
    // Row-level transaction helpers + order/payment transitions (V5 + V7).
    StateMachineService,
    // Per-merchant in-process semaphore (V7, D9).
    PerMerchantSemaphore,
    // Channel ↔ Viva account helpers (V7 + V9).
    ConnectedAccountsService,
    // Webhook worker job handler — registers queue on bootstrap (V7).
    ProcessVivaWebhookHandler,
    // 90-day webhook event retention cleanup — daily setInterval (V7).
    RetentionCleanupHandler,
    // Shop API mutation resolver — cancelPayment (V8).
    VivaShopApiResolver,
    // In-process metrics state singleton (V10).
    MetricsStateService,
  ],
  entities: [VivaTransaction, VivaWebhookEvent],
  exports: [VIVA_PLUGIN_OPTIONS, VivaBootstrap, StateMachineService, PerMerchantSemaphore, ConnectedAccountsService, ProcessVivaWebhookHandler, MetricsStateService],
  compatibility: '^3.0.0',
  configuration: (config: RuntimeVendureConfig): RuntimeVendureConfig => {
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
      vivaPaymentMethodHandler,
    ];
    // Register the custom payment process that legalises the Created → Created
    // self-transition our createPayment forces (public #10). Without this,
    // PaymentService.createPayment's transition(payment, 'Created') is rejected
    // by the default FSM → addPaymentToOrder 500s → /?paymentInProgress=1.
    config.paymentOptions.customPaymentProcess = [
      ...(config.paymentOptions.customPaymentProcess ?? []),
      vivaPaymentProcess,
    ];
    return config;
  },
})
export class VivaPaymentPlugin {
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
  static init(options: VivaPaymentPluginInitInput | VivaPaymentPluginOptions): typeof VivaPaymentPlugin {
    pluginOptions = normalizePluginOptions(options as VivaPaymentPluginInitInput);
    return VivaPaymentPlugin;
  }

  /**
   * @internal Test-only: reset module-level init() warning flags.
   * Used by `test/plugin/init-validation.test.ts`.
   */
  static _resetInitNoticesForTesting(): void {
    _resetInitNoticesForTesting();
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
}
