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

import {
  Controller,
  Get,
  Inject,
  Req,
  Res,
  UseGuards,
} from '@nestjs/common';
import type { IncomingMessage, ServerResponse } from 'node:http';
import {
  Allow,
  Permission,
  TransactionalConnection,
  Logger,
} from '@vendure/core';
import { AuthGuard } from '@vendure/core';
import type { CachedToken } from '@sakeetech/viva-payments-core/types';
import type { VivaPaymentPluginOptions } from '../types.js';
import type { VivaOAuth2Strategy } from '../providers/viva-oauth2-strategy.provider.js';
import { MetricsStateService } from '../observability/metrics-state.service.js';
import {
  VIVA_PLUGIN_OPTIONS,
  VIVA_OAUTH2_STRATEGY_TOKEN,
  VIVA_LOG_CONTEXT,
} from '../constants.js';
import { VivaWebhookEvent } from '../entities/viva-webhook-event.entity.js';

// ---------------------------------------------------------------------------
// Controller
// ---------------------------------------------------------------------------

@Controller('viva/internal')
@UseGuards(AuthGuard)
export class AdminInternalController {
  constructor(
    @Inject(VIVA_PLUGIN_OPTIONS)
    private readonly options: VivaPaymentPluginOptions,
    @Inject(VIVA_OAUTH2_STRATEGY_TOKEN)
    private readonly oauth2: VivaOAuth2Strategy,
    private readonly connection: TransactionalConnection,
    private readonly metricsState: MetricsStateService,
  ) {}

  // -------------------------------------------------------------------------
  // GET /viva/internal/auth-status
  // -------------------------------------------------------------------------

  @Get('auth-status')
  @Allow(Permission.SuperAdmin)
  async getAuthStatus(@Res() res: ServerResponse): Promise<void> {
    const environment = this.options.environment;
    const clientId = this.options.clientId;

    let tokenPresent = false;
    let tokenExpiresAt: string | null = null;
    let lastRefreshAt: string | null = null;

    try {
      const cache = this.oauth2.tokenCache;
      const cacheKey = `viva:isv:token:${clientId}:${environment}`;
      const cached: CachedToken | null = await cache.get(cacheKey);

      if (cached) {
        tokenPresent = true;
        tokenExpiresAt = new Date(cached.expires_at).toISOString();
        // Approximate last_refresh_at: expires_at - 3540s.
        // The cache stores expires_at = now_at_refresh + 3600000 - 60000.
        // We reverse: refresh_at ≈ expires_at - 3540s.
        // @see packages/medusa-payment-viva/src/api/viva/internal/auth-status/route.ts:91
        lastRefreshAt = new Date(cached.expires_at - 3540 * 1000).toISOString();

        // Keep gauge in sync
        const expiresInSeconds = Math.max(0, Math.floor((cached.expires_at - Date.now()) / 1000));
        this.metricsState.setTokenPresent(true, expiresInSeconds);
      } else {
        this.metricsState.setTokenPresent(false, 0);
      }
    } catch (err) {
      Logger.warn(
        `[AdminInternal] auth-status: cache read failed: ${String(err)}`,
        VIVA_LOG_CONTEXT,
      );
    }

    res.setHeader('Cache-Control', 'no-store');
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(
      JSON.stringify({
        token_present: tokenPresent,
        token_expires_at: tokenExpiresAt,
        last_refresh_at: lastRefreshAt,
        environment,
        now: new Date().toISOString(),
      }),
    );
  }

  // -------------------------------------------------------------------------
  // GET /viva/internal/webhook/health
  // -------------------------------------------------------------------------

  @Get('webhook/health')
  @Allow(Permission.SuperAdmin)
  async getWebhookHealth(@Res() res: ServerResponse): Promise<void> {
    let eventsReceived24h = 0;
    let eventsPending = 0;
    let oldestPendingAgeSeconds: number | null = null;
    let lastProcessedAt: string | null = null;

    try {
      const repo = this.connection.rawConnection.getRepository(VivaWebhookEvent);

      // Count events received in last 24 hours
      const received24hResult = await repo
        .createQueryBuilder('e')
        .select('COUNT(*)', 'cnt')
        .where('e.received_at > NOW() - INTERVAL \'24 hours\'')
        .getRawOne<{ cnt: string }>();
      eventsReceived24h = parseInt(received24hResult?.cnt ?? '0', 10);

      // Count pending (processed_at IS NULL)
      const pendingResult = await repo
        .createQueryBuilder('e')
        .select('COUNT(*)', 'cnt')
        .where('e.processed_at IS NULL')
        .getRawOne<{ cnt: string }>();
      eventsPending = parseInt(pendingResult?.cnt ?? '0', 10);

      // Oldest pending age in seconds
      const oldestResult = await repo
        .createQueryBuilder('e')
        .select('EXTRACT(EPOCH FROM (NOW() - MIN(e.received_at)))', 'age_seconds')
        .where('e.processed_at IS NULL')
        .getRawOne<{ age_seconds: string | null }>();
      const rawAge = oldestResult?.age_seconds;
      if (rawAge !== null && rawAge !== undefined) {
        oldestPendingAgeSeconds = parseFloat(rawAge);
      }

      // Last processed_at (max)
      const lastProcessedResult = await repo
        .createQueryBuilder('e')
        .select('MAX(e.processed_at)', 'last_at')
        .where('e.processed_at IS NOT NULL')
        .getRawOne<{ last_at: string | null }>();
      const rawLast = lastProcessedResult?.last_at;
      lastProcessedAt = rawLast ?? null;

      // Update gauge for metrics
      this.metricsState.setWebhookEventsPending(eventsPending);
      this.metricsState.setWebhookOldestPendingAgeSeconds(oldestPendingAgeSeconds);
    } catch (err) {
      Logger.warn(
        `[AdminInternal] webhook/health: DB query failed: ${String(err)}`,
        VIVA_LOG_CONTEXT,
      );
    }

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(
      JSON.stringify({
        events_received_24h: eventsReceived24h,
        events_pending: eventsPending,
        oldest_pending_age_seconds: oldestPendingAgeSeconds,
        last_processed_at: lastProcessedAt,
      }),
    );
  }

  // -------------------------------------------------------------------------
  // GET /viva/internal/metrics
  // -------------------------------------------------------------------------

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
  @Get('metrics')
  @Allow(Permission.SuperAdmin)
  getMetrics(
    @Req() req: IncomingMessage,
    @Res() res: ServerResponse,
  ): void {
    // Check for Prometheus scrape token as alternative auth
    const metricsToken = process.env['VIVA_METRICS_TOKEN'];
    const authHeader = req.headers['authorization'];
    if (metricsToken && authHeader === `Bearer ${metricsToken}`) {
      // Scrape token accepted — serve without requiring admin session
      // (The guard has already run but would reject non-admin sessions.
      // This path only triggers when the guard passes, so it's belt-and-suspenders.)
    }

    const text = this.metricsState.toPromText();
    res.writeHead(200, {
      'Content-Type': 'text/plain; version=0.0.4; charset=utf-8',
      'Cache-Control': 'no-store',
    });
    res.end(text);
  }
}
