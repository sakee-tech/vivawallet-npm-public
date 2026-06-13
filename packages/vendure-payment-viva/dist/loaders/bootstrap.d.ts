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
import type { OnApplicationBootstrap } from '@nestjs/common';
import type { VivaPaymentPluginOptions } from '../types.js';
import type { VivaOAuth2Strategy } from '../providers/viva-oauth2-strategy.provider.js';
export declare class VivaBootstrap implements OnApplicationBootstrap {
    private readonly options;
    private readonly oauth2;
    constructor(options: VivaPaymentPluginOptions, oauth2: VivaOAuth2Strategy);
    private _lastWarmupFailed;
    get lastWarmupFailed(): boolean;
    onApplicationBootstrap(): Promise<void>;
    private _runWarmup;
}
//# sourceMappingURL=bootstrap.d.ts.map