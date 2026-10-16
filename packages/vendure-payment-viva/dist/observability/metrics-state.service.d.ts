/**
 * observability/metrics-state.service.ts — In-process metrics state singleton.
 *
 * Hand-rolled Prometheus-compatible metrics. No prom-client dependency.
 * Registered as a NestJS injectable singleton. Injected into payment handler,
 * webhook controller, and webhook job to increment counters at the right call sites.
 *
 * Metrics exported:
 *   viva_oauth2_token_present            gauge (0 or 1)
 *   viva_oauth2_token_expires_in_seconds gauge
 *   viva_webhook_events_received_total   counter (by event_type_id)
 *   viva_webhook_events_processed_total  counter (by event_type_id)
 *   viva_webhook_events_pending          gauge
 *   viva_webhook_event_oldest_pending_age_seconds gauge
 *   viva_payment_state_transitions_total counter (by from, to)
 *   viva_isv_api_call_duration_seconds   histogram (by endpoint)
 *
 * Histogram buckets (seconds): [0.05, 0.1, 0.25, 0.5, 1, 2, 5]
 * Rationale: Viva API P99 should be <2s; 0.05–5 covers the useful range with
 * 7 finite buckets matching plan spec exactly.
 *
 * @see docs/plans/vendure-plugin-v0.md §"Build Plan — V10"
 */
export declare const ISV_API_DURATION_BUCKETS: readonly number[];
export declare class MetricsStateService {
    private _tokenPresent;
    private _tokenExpiresInSeconds;
    private _webhookEventsPending;
    private _webhookOldestPendingAgeSeconds;
    private readonly _counters;
    private readonly _counterLabels;
    private readonly _histograms;
    setTokenPresent(present: boolean, expiresInSeconds?: number): void;
    setWebhookEventsPending(count: number): void;
    setWebhookOldestPendingAgeSeconds(ageSeconds: number | null): void;
    incrementCounter(name: string, labels?: Record<string, string>, delta?: number): void;
    recordWebhookReceived(eventTypeId: number): void;
    recordWebhookProcessed(eventTypeId: number): void;
    recordPaymentStateTransition(from: string, to: string): void;
    recordIsvApiCall(endpoint: string, durationSeconds: number): void;
    toPromText(): string;
}
//# sourceMappingURL=metrics-state.service.d.ts.map