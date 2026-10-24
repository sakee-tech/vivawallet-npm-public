/**
 * api/admin-internal.controller.ts — Admin internal health + metrics endpoints.
 *
 * Mounted under /viva/internal. All routes gated by Permission.SuperAdmin + AuthGuard.
 *
 *   GET /viva/internal/auth-status
 *     Returns {token_present, token_expires_at, last_refresh_at, environment}.
 *     Reads directly from the singleton OAuth2 strategy's InMemoryTokenCache.
 *     Cache key pattern: `viva:isv:token:{clientId}:{environment}`.
 *     Mirrors Medusa's route.ts auth-status implementation (adapted to Nest DI).
 *
 *   GET /viva/internal/webhook/health
 *     Returns {events_received_24h, events_pending, oldest_pending_age_seconds, last_processed_at}.
 *     Queries viva_webhook_event table directly.
 *
 *   GET /viva/internal/metrics
 *     Returns Prometheus text format (text/plain; version=0.0.4).
 *     Hand-rolled — NO prom-client. Uses MetricsStateService singleton.
 *     Optionally accepts Bearer <VIVA_METRICS_TOKEN> as alternative to admin auth.
 *
 * @see docs/plans/vendure-plugin-v0.md §"API Surface — REST endpoints" (V10)
 * @see packages/medusa-payment-viva/src/api/viva/internal/auth-status/route.ts (reference)
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import { TransactionalConnection } from '@vendure/core';
import type { VivaPaymentPluginOptions } from '../types.js';
import type { VivaOAuth2Strategy } from '../providers/viva-oauth2-strategy.provider.js';
import { MetricsStateService } from '../observability/metrics-state.service.js';
export declare class AdminInternalController {
    private readonly options;
    private readonly oauth2;
    private readonly connection;
    private readonly metricsState;
    constructor(options: VivaPaymentPluginOptions, oauth2: VivaOAuth2Strategy, connection: TransactionalConnection, metricsState: MetricsStateService);
    getAuthStatus(res: ServerResponse): Promise<void>;
    getWebhookHealth(res: ServerResponse): Promise<void>;
    /**
     * Prometheus text format endpoint.
     *
     * Two auth modes:
     *   1. Vendure admin session with SuperAdmin permission (normal admin flow).
     *   2. `Authorization: Bearer <VIVA_METRICS_TOKEN>` — allows Prometheus scraper
     *      to authenticate without a Vendure session. Set VIVA_METRICS_TOKEN env var.
     *
     * The @Allow(Permission.SuperAdmin) guard handles mode 1.
     * Mode 2 is checked FIRST via a raw header check before the guard's rejection.
     * Since we can't bypass @UseGuards at the method level, metrics is handled
     * as an additional check in a separate non-guarded path. Instead, we use
     * a permissive approach: the controller-level AuthGuard gates everything, but
     * the metrics endpoint additionally accepts the scrape token as an alternative.
     *
     * TODO(impl): To fully support unauthenticated Prometheus scraping, split this
     * controller: move /metrics to a separate controller without @UseGuards(AuthGuard).
     * For now, VIVA_METRICS_TOKEN is checked but the admin guard still applies.
     * Operators can use VIVA_METRICS_TOKEN via a separate scraper proxy if needed.
     */
    getMetrics(req: IncomingMessage, res: ServerResponse): void;
}
//# sourceMappingURL=admin-internal.controller.d.ts.map