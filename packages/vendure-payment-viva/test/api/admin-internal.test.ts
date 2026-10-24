/**
 * test/api/admin-internal.test.ts — AdminInternalController unit tests.
 *
 * Uses a minimal Nest-free harness (same pattern as admin-onboarding.test.ts).
 * No DB, no full Vendure bootstrap required.
 *
 * Coverage:
 *  1.  auth-status: token present — returns token_present=true + expires_at ISO string
 *  2.  auth-status: no cache entry → token_present=false
 *  3.  auth-status: cache throws → degrades gracefully, returns token_present=false
 *  4.  auth-status: response contains environment field matching options
 *  5.  webhook/health: returns zero counts on empty DB mock
 *  6.  webhook/health: returns seeded counts from DB mock
 *  7.  webhook/health: DB failure → returns zeros gracefully
 *  8.  metrics: returns valid Prometheus text format (has HELP + TYPE lines)
 *  9.  metrics: counter increments visible in output after recordWebhookReceived
 *  10. metrics: histogram bucket lines present after recordIsvApiCall
 *  11. metrics: returns 200 with text/plain content-type
 *  12. auth-status: last_refresh_at is approximately (expires_at - 3540s)
 *
 * Note: Auth guard (401/403) is wired via Vendure's AuthGuard which requires
 * the full Nest DI context. Skipped here per V9 convention — see V11 for
 * integration-level auth tests.
 *
 * @see docs/plans/vendure-plugin-v0.md §"Build Plan — V10"
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { AdminInternalController } from '../../src/api/admin-internal.controller.js';
import { MetricsStateService } from '../../src/observability/metrics-state.service.js';
import type { VivaPaymentPluginOptions } from '../../src/types.js';

// ---------------------------------------------------------------------------
// Response mock
// ---------------------------------------------------------------------------

function makeMockResponse(): ServerResponse & {
  _status: number;
  _body: string;
  _headers: Record<string, string>;
} {
  let status = 200;
  let body = '';
  const headers: Record<string, string> = {};
  return {
    _status: 200,
    _body: '',
    _headers: headers,
    setHeader(name: string, value: string) {
      headers[name] = value;
    },
    writeHead(s: number, hdrs?: Record<string, string>) {
      status = s;
      (this as any)._status = s;
      if (hdrs) Object.assign(headers, hdrs);
      (this as any)._headers = headers;
    },
    end(data?: string) {
      body = data ?? '';
      (this as any)._body = body;
    },
  } as unknown as ServerResponse & { _status: number; _body: string; _headers: Record<string, string> };
}

function makeRequest(authHeader?: string): IncomingMessage {
  return {
    headers: authHeader ? { authorization: authHeader } : {},
  } as IncomingMessage;
}

// ---------------------------------------------------------------------------
// Plugin options factory
// ---------------------------------------------------------------------------

function makeOptions(overrides: Partial<VivaPaymentPluginOptions> = {}): VivaPaymentPluginOptions {
  return {
    mode: 'isv' as const,

    clientId: 'test-client-id',
    clientSecret: 'test-client-secret',
    onboardingReturnUrl: 'https://example.com/onboarding-return',
    environment: 'demo',
    webhookVerificationKey: 'test-verify-key',
    legacyMerchantId: 'test-legacy-merchant-uuid',
    legacyApiKey: 'test-legacy-api-key',
    successUrl: 'https://example.com/success',
    failureUrl: 'https://example.com/failure',
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// OAuth2 strategy mock
// ---------------------------------------------------------------------------

function makeOAuth2Mock(cachedToken?: { access_token: string; expires_at: number; scope: string }) {
  const mockCache = {
    get: vi.fn().mockResolvedValue(cachedToken ?? null),
    set: vi.fn(),
    del: vi.fn(),
  };
  return {
    tokenCache: mockCache,
    getBearerToken: vi.fn().mockResolvedValue('mock-token'),
    name: 'oauth2-client-credentials',
  };
}

// ---------------------------------------------------------------------------
// TransactionalConnection mock
// ---------------------------------------------------------------------------

function makeConnectionMock(queryResults: {
  received24h?: number;
  pending?: number;
  oldestAge?: number | null;
  lastProcessed?: string | null;
}) {
  const makeQueryBuilder = (result: unknown) => ({
    select: vi.fn().mockReturnThis(),
    where: vi.fn().mockReturnThis(),
    from: vi.fn().mockReturnThis(),
    getRawOne: vi.fn().mockResolvedValue(result),
    createQueryBuilder: vi.fn().mockReturnThis(),
  });

  let callCount = 0;
  const results = [
    { cnt: String(queryResults.received24h ?? 0) },
    { cnt: String(queryResults.pending ?? 0) },
    queryResults.oldestAge !== undefined && queryResults.oldestAge !== null
      ? { age_seconds: String(queryResults.oldestAge) }
      : { age_seconds: null },
    { last_at: queryResults.lastProcessed ?? null },
  ];

  const repo = {
    createQueryBuilder: vi.fn().mockImplementation(() => {
      const result = results[callCount++ % results.length];
      return {
        select: vi.fn().mockReturnThis(),
        where: vi.fn().mockReturnThis(),
        getRawOne: vi.fn().mockResolvedValue(result),
      };
    }),
  };

  return {
    rawConnection: {
      getRepository: vi.fn().mockReturnValue(repo),
    },
  };
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

function makeController(opts?: {
  options?: Partial<VivaPaymentPluginOptions>;
  cachedToken?: { access_token: string; expires_at: number; scope: string };
  cacheThrows?: boolean;
  dbResults?: {
    received24h?: number;
    pending?: number;
    oldestAge?: number | null;
    lastProcessed?: string | null;
  };
  dbThrows?: boolean;
}): { controller: AdminInternalController; metricsState: MetricsStateService } {
  const options = makeOptions(opts?.options);
  const oauth2 = makeOAuth2Mock(opts?.cachedToken);

  if (opts?.cacheThrows) {
    oauth2.tokenCache.get.mockRejectedValue(new Error('cache error'));
  }

  let connection: ReturnType<typeof makeConnectionMock>;
  if (opts?.dbThrows) {
    const badRepo = {
      createQueryBuilder: vi.fn().mockImplementation(() => {
        throw new Error('DB error');
      }),
    };
    connection = {
      rawConnection: {
        getRepository: vi.fn().mockReturnValue(badRepo),
      },
    } as unknown as ReturnType<typeof makeConnectionMock>;
  } else {
    connection = makeConnectionMock(opts?.dbResults ?? {});
  }

  const metricsState = new MetricsStateService();

  const controller = new AdminInternalController(
    options,
    oauth2 as any,
    connection as any,
    metricsState,
  );

  return { controller, metricsState };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('AdminInternalController', () => {
  // -------------------------------------------------------------------------
  // auth-status
  // -------------------------------------------------------------------------

  describe('GET /viva/internal/auth-status', () => {
    it('returns token_present=true when cache has a valid token', async () => {
      const expiresAt = Date.now() + 3600 * 1000;
      const { controller } = makeController({
        cachedToken: { access_token: 'tok', expires_at: expiresAt, scope: 'payments' },
      });
      const res = makeMockResponse();
      await controller.getAuthStatus(res as any);

      expect(res._status).toBe(200);
      const body = JSON.parse(res._body);
      expect(body.token_present).toBe(true);
      expect(typeof body.token_expires_at).toBe('string');
      // ISO string format
      expect(body.token_expires_at).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    });

    it('token_expires_at matches expected ISO value', async () => {
      const expiresAt = 1_700_000_000_000; // fixed epoch
      const { controller } = makeController({
        cachedToken: { access_token: 'tok', expires_at: expiresAt, scope: 'payments' },
      });
      const res = makeMockResponse();
      await controller.getAuthStatus(res as any);

      const body = JSON.parse(res._body);
      expect(body.token_expires_at).toBe(new Date(expiresAt).toISOString());
    });

    it('returns token_present=false when cache returns null', async () => {
      const { controller } = makeController({ cachedToken: undefined });
      const res = makeMockResponse();
      await controller.getAuthStatus(res as any);

      expect(res._status).toBe(200);
      const body = JSON.parse(res._body);
      expect(body.token_present).toBe(false);
      expect(body.token_expires_at).toBeNull();
      expect(body.last_refresh_at).toBeNull();
    });

    it('degrades gracefully when cache.get throws', async () => {
      const { controller } = makeController({ cacheThrows: true });
      const res = makeMockResponse();
      await controller.getAuthStatus(res as any);

      expect(res._status).toBe(200);
      const body = JSON.parse(res._body);
      expect(body.token_present).toBe(false);
    });

    it('returns correct environment from plugin options', async () => {
      const { controller } = makeController({ options: { environment: 'production' } });
      const res = makeMockResponse();
      await controller.getAuthStatus(res as any);

      const body = JSON.parse(res._body);
      expect(body.environment).toBe('production');
    });

    it('last_refresh_at approximation is ~3540s before expires_at', async () => {
      const expiresAt = Date.now() + 3600 * 1000;
      const { controller } = makeController({
        cachedToken: { access_token: 'tok', expires_at: expiresAt, scope: '' },
      });
      const res = makeMockResponse();
      await controller.getAuthStatus(res as any);

      const body = JSON.parse(res._body);
      const refreshAt = new Date(body.last_refresh_at).getTime();
      const diff = expiresAt - refreshAt;
      expect(diff).toBe(3540 * 1000);
    });
  });

  // -------------------------------------------------------------------------
  // webhook/health
  // -------------------------------------------------------------------------

  describe('GET /viva/internal/webhook/health', () => {
    it('returns zero counts when DB returns zeros', async () => {
      const { controller } = makeController({
        dbResults: { received24h: 0, pending: 0, oldestAge: null, lastProcessed: null },
      });
      const res = makeMockResponse();
      await controller.getWebhookHealth(res as any);

      expect(res._status).toBe(200);
      const body = JSON.parse(res._body);
      expect(body.events_received_24h).toBe(0);
      expect(body.events_pending).toBe(0);
      expect(body.oldest_pending_age_seconds).toBeNull();
      expect(body.last_processed_at).toBeNull();
    });

    it('returns seeded counts from DB mock', async () => {
      const { controller } = makeController({
        dbResults: {
          received24h: 42,
          pending: 3,
          oldestAge: 120.5,
          lastProcessed: '2024-01-01T00:00:00Z',
        },
      });
      const res = makeMockResponse();
      await controller.getWebhookHealth(res as any);

      expect(res._status).toBe(200);
      const body = JSON.parse(res._body);
      expect(body.events_received_24h).toBe(42);
      expect(body.events_pending).toBe(3);
      expect(body.oldest_pending_age_seconds).toBeCloseTo(120.5);
    });

    it('degrades gracefully on DB failure', async () => {
      const { controller } = makeController({ dbThrows: true });
      const res = makeMockResponse();
      await controller.getWebhookHealth(res as any);

      expect(res._status).toBe(200);
      const body = JSON.parse(res._body);
      expect(body.events_received_24h).toBe(0);
      expect(body.events_pending).toBe(0);
    });
  });

  // -------------------------------------------------------------------------
  // metrics
  // -------------------------------------------------------------------------

  describe('GET /viva/internal/metrics', () => {
    it('returns 200 with text/plain content-type', () => {
      const { controller } = makeController();
      const req = makeRequest();
      const res = makeMockResponse();
      controller.getMetrics(req as any, res as any);

      expect(res._status).toBe(200);
      expect(res._headers['Content-Type']).toMatch(/text\/plain/);
    });

    it('returns valid Prometheus exposition format with HELP + TYPE lines', () => {
      const { controller } = makeController();
      const req = makeRequest();
      const res = makeMockResponse();
      controller.getMetrics(req as any, res as any);

      const text = res._body;
      expect(text).toMatch(/^# HELP /m);
      expect(text).toMatch(/^# TYPE /m);
      // Each metric line matches: name + optional labels + space + value
      const metricLines = text.split('\n').filter(
        (l) => l.length > 0 && !l.startsWith('#'),
      );
      for (const line of metricLines) {
        expect(line).toMatch(/^[a-z_][a-z0-9_]*({.*})? [0-9.]+$/);
      }
    });

    it('counter increments visible after recordWebhookReceived', () => {
      const { controller, metricsState } = makeController();
      metricsState.recordWebhookReceived(1796);
      metricsState.recordWebhookReceived(1796);
      metricsState.recordWebhookReceived(1798);

      const req = makeRequest();
      const res = makeMockResponse();
      controller.getMetrics(req as any, res as any);

      const text = res._body;
      expect(text).toContain('viva_webhook_events_received_total{event_type_id="1796"} 2');
      expect(text).toContain('viva_webhook_events_received_total{event_type_id="1798"} 1');
    });

    it('histogram bucket lines present after recordIsvApiCall', () => {
      const { controller, metricsState } = makeController();
      metricsState.recordIsvApiCall('createOrder', 0.3);

      const req = makeRequest();
      const res = makeMockResponse();
      controller.getMetrics(req as any, res as any);

      const text = res._body;
      expect(text).toContain('viva_isv_api_call_duration_seconds_bucket');
      expect(text).toContain('viva_isv_api_call_duration_seconds_sum');
      expect(text).toContain('viva_isv_api_call_duration_seconds_count');
      // 0.3s should be in le=0.5 bucket
      expect(text).toContain('{endpoint="createOrder",le="0.5"} 1');
      // Not in le=0.1 bucket
      expect(text).toContain('{endpoint="createOrder",le="0.1"} 0');
    });

    it('token present gauge updates from auth-status call', async () => {
      const expiresAt = Date.now() + 3600 * 1000;
      const { controller, metricsState } = makeController({
        cachedToken: { access_token: 'tok', expires_at: expiresAt, scope: '' },
      });

      // Call auth-status to update the gauge
      const authRes = makeMockResponse();
      await controller.getAuthStatus(authRes as any);

      const req = makeRequest();
      const metricsRes = makeMockResponse();
      controller.getMetrics(req as any, metricsRes as any);

      expect(metricsRes._body).toContain('viva_oauth2_token_present 1');
    });
  });
});

// ---------------------------------------------------------------------------
// MetricsStateService unit tests
// ---------------------------------------------------------------------------

describe('MetricsStateService', () => {
  it('toPromText() contains all gauge metric names', () => {
    const svc = new MetricsStateService();
    const text = svc.toPromText();
    expect(text).toContain('viva_oauth2_token_present');
    expect(text).toContain('viva_oauth2_token_expires_in_seconds');
    expect(text).toContain('viva_webhook_events_pending');
    expect(text).toContain('viva_webhook_event_oldest_pending_age_seconds');
  });

  it('recordPaymentStateTransition increments counter with correct labels', () => {
    const svc = new MetricsStateService();
    svc.recordPaymentStateTransition('Created', 'Settled');
    svc.recordPaymentStateTransition('Created', 'Settled');
    const text = svc.toPromText();
    expect(text).toContain('viva_payment_state_transitions_total{from="Created",to="Settled"} 2');
  });

  it('recordWebhookProcessed increments separate from received', () => {
    const svc = new MetricsStateService();
    svc.recordWebhookReceived(1796);
    svc.recordWebhookProcessed(1796);
    svc.recordWebhookProcessed(1796);
    const text = svc.toPromText();
    expect(text).toContain('viva_webhook_events_received_total{event_type_id="1796"} 1');
    expect(text).toContain('viva_webhook_events_processed_total{event_type_id="1796"} 2');
  });

  it('setWebhookEventsPending updates gauge correctly', () => {
    const svc = new MetricsStateService();
    svc.setWebhookEventsPending(7);
    const text = svc.toPromText();
    expect(text).toContain('viva_webhook_events_pending 7');
  });

  it('histogram +Inf bucket always equals count', () => {
    const svc = new MetricsStateService();
    svc.recordIsvApiCall('listWebhooks', 0.05);
    svc.recordIsvApiCall('listWebhooks', 10);
    const text = svc.toPromText();
    // +Inf should be 2
    expect(text).toContain('{endpoint="listWebhooks",le="+Inf"} 2');
    expect(text).toContain('viva_isv_api_call_duration_seconds_count{endpoint="listWebhooks"} 2');
  });
});
