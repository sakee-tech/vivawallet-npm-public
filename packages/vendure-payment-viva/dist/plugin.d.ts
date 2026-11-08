/**
 * plugin.ts — VivaPaymentPlugin Vendure module.
 *
 * V4: wires entities, channel custom fields, OAuth2 singleton provider,
 * and the bootstrap warmup service. Payment handler, controllers, and
 * webhook job are wired in V5+.
 *
 * @see docs/plans/vendure-plugin-v0.md §D19, §"Build Plan (Waves) — V4"
 */
import type { VivaPaymentPluginOptions, VivaPaymentPluginInitInput } from './types.js';
export declare class VivaPaymentPlugin {
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
     *   // Bookkeeping only — NOT sent to Viva. The customer's post-payment
     *   // redirect is governed by the source's pathSuccess/pathFail, not these.
     *   // See VivaPaymentPluginOptions.successUrl and #15.
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
    static init(options: VivaPaymentPluginInitInput | VivaPaymentPluginOptions): typeof VivaPaymentPlugin;
    /**
     * @internal Test-only: reset module-level init() warning flags.
     * Used by `test/plugin/init-validation.test.ts`.
     */
    static _resetInitNoticesForTesting(): void;
    /**
     * Exposes the channel custom field definitions for testing / inspection.
     * Mode-aware: returns the fields registered for the current init() mode.
     * Falls back to the ISV field set when init() hasn't been called yet so
     * existing snapshot tests continue to see the full list by default.
     * @internal
     */
    static get channelCustomFields(): ({
        name: string;
        type: "string";
        nullable: boolean;
        public: boolean;
        ui: {
            component: string;
        };
        description: {
            languageCode: any;
            value: string;
        }[];
        defaultValue?: never;
    } | {
        name: string;
        type: "boolean";
        nullable: boolean;
        defaultValue: boolean;
        public: boolean;
        description: {
            languageCode: any;
            value: string;
        }[];
        ui?: never;
    } | {
        name: string;
        type: "string";
        nullable: boolean;
        defaultValue: string;
        public: boolean;
        description: {
            languageCode: any;
            value: string;
        }[];
    } | {
        name: string;
        type: "boolean";
        nullable: boolean;
        defaultValue: boolean;
        public: boolean;
        description: {
            languageCode: any;
            value: string;
        }[];
    })[];
}
//# sourceMappingURL=plugin.d.ts.map