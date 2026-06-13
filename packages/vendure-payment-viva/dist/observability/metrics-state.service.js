"use strict";
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
var __decorate = (this && this.__decorate) || function (decorators, target, key, desc) {
    var c = arguments.length, r = c < 3 ? target : desc === null ? desc = Object.getOwnPropertyDescriptor(target, key) : desc, d;
    if (typeof Reflect === "object" && typeof Reflect.decorate === "function") r = Reflect.decorate(decorators, target, key, desc);
    else for (var i = decorators.length - 1; i >= 0; i--) if (d = decorators[i]) r = (c < 3 ? d(r) : c > 3 ? d(target, key, r) : d(target, key)) || r;
    return c > 3 && r && Object.defineProperty(target, key, r), r;
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.MetricsStateService = exports.ISV_API_DURATION_BUCKETS = void 0;
const common_1 = require("@nestjs/common");
// ---------------------------------------------------------------------------
// Histogram buckets
// ---------------------------------------------------------------------------
exports.ISV_API_DURATION_BUCKETS = Object.freeze([
    0.05, 0.1, 0.25, 0.5, 1, 2, 5,
]);
// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function labelKey(labels) {
    const keys = Object.keys(labels).sort();
    return keys.map((k) => `${k}=${labels[k]}`).join(',');
}
function labelStr(labels) {
    const keys = Object.keys(labels).sort();
    if (keys.length === 0)
        return '';
    const parts = keys.map((k) => `${k}="${labels[k]}"`);
    return `{${parts.join(',')}}`;
}
// ---------------------------------------------------------------------------
// MetricsStateService
// ---------------------------------------------------------------------------
let MetricsStateService = class MetricsStateService {
    // -------------------------------------------------------------------------
    // Gauge state
    // -------------------------------------------------------------------------
    _tokenPresent = 0;
    _tokenExpiresInSeconds = 0;
    _webhookEventsPending = 0;
    _webhookOldestPendingAgeSeconds = 0;
    // -------------------------------------------------------------------------
    // Counter state: name → labelKey → value
    // -------------------------------------------------------------------------
    _counters = new Map();
    _counterLabels = new Map();
    // -------------------------------------------------------------------------
    // Histogram state: name → HistogramState
    // -------------------------------------------------------------------------
    _histograms = new Map();
    // ---------------------------------------------------------------------------
    // Gauge setters — called by bootstrap, auth strategy refresh
    // ---------------------------------------------------------------------------
    setTokenPresent(present, expiresInSeconds = 0) {
        this._tokenPresent = present ? 1 : 0;
        this._tokenExpiresInSeconds = present ? Math.max(0, expiresInSeconds) : 0;
    }
    setWebhookEventsPending(count) {
        this._webhookEventsPending = count;
    }
    setWebhookOldestPendingAgeSeconds(ageSeconds) {
        this._webhookOldestPendingAgeSeconds = ageSeconds ?? 0;
    }
    // ---------------------------------------------------------------------------
    // Counter increment
    // ---------------------------------------------------------------------------
    incrementCounter(name, labels = {}, delta = 1) {
        let byLabel = this._counters.get(name);
        let byLabelObj = this._counterLabels.get(name);
        if (!byLabel) {
            byLabel = new Map();
            this._counters.set(name, byLabel);
        }
        if (!byLabelObj) {
            byLabelObj = new Map();
            this._counterLabels.set(name, byLabelObj);
        }
        const key = labelKey(labels);
        byLabel.set(key, (byLabel.get(key) ?? 0) + delta);
        byLabelObj.set(key, labels);
    }
    // Convenience wrappers
    recordWebhookReceived(eventTypeId) {
        this.incrementCounter('viva_webhook_events_received_total', {
            event_type_id: String(eventTypeId),
        });
    }
    recordWebhookProcessed(eventTypeId) {
        this.incrementCounter('viva_webhook_events_processed_total', {
            event_type_id: String(eventTypeId),
        });
    }
    recordPaymentStateTransition(from, to) {
        this.incrementCounter('viva_payment_state_transitions_total', { from, to });
    }
    // ---------------------------------------------------------------------------
    // Histogram record
    // ---------------------------------------------------------------------------
    recordIsvApiCall(endpoint, durationSeconds) {
        const name = 'viva_isv_api_call_duration_seconds';
        const labels = { endpoint };
        const key = labelKey(labels);
        let state = this._histograms.get(name);
        if (!state) {
            state = {
                counts: new Map(),
                sum: new Map(),
                count: new Map(),
                labelMap: new Map(),
            };
            this._histograms.set(name, state);
        }
        state.labelMap.set(key, labels);
        if (!state.counts.has(key)) {
            // +1 slot for +Inf
            state.counts.set(key, new Array(exports.ISV_API_DURATION_BUCKETS.length + 1).fill(0));
        }
        const bucketCounts = state.counts.get(key);
        for (let i = 0; i < exports.ISV_API_DURATION_BUCKETS.length; i++) {
            if (durationSeconds <= exports.ISV_API_DURATION_BUCKETS[i]) {
                bucketCounts[i];
                bucketCounts[i] = (bucketCounts[i] ?? 0) + 1;
            }
        }
        // +Inf always
        bucketCounts[exports.ISV_API_DURATION_BUCKETS.length] =
            (bucketCounts[exports.ISV_API_DURATION_BUCKETS.length] ?? 0) + 1;
        state.sum.set(key, (state.sum.get(key) ?? 0) + durationSeconds);
        state.count.set(key, (state.count.get(key) ?? 0) + 1);
    }
    // ---------------------------------------------------------------------------
    // Prometheus text exposition
    // ---------------------------------------------------------------------------
    toPromText() {
        const lines = [];
        // Gauges
        lines.push('# HELP viva_oauth2_token_present 1 if an OAuth2 token is cached, 0 otherwise.');
        lines.push('# TYPE viva_oauth2_token_present gauge');
        lines.push(`viva_oauth2_token_present ${this._tokenPresent}`);
        lines.push('');
        lines.push('# HELP viva_oauth2_token_expires_in_seconds Seconds until the cached OAuth2 token expires.');
        lines.push('# TYPE viva_oauth2_token_expires_in_seconds gauge');
        lines.push(`viva_oauth2_token_expires_in_seconds ${this._tokenExpiresInSeconds}`);
        lines.push('');
        lines.push('# HELP viva_webhook_events_pending Number of webhook events with processed_at IS NULL.');
        lines.push('# TYPE viva_webhook_events_pending gauge');
        lines.push(`viva_webhook_events_pending ${this._webhookEventsPending}`);
        lines.push('');
        lines.push('# HELP viva_webhook_event_oldest_pending_age_seconds Age in seconds of the oldest pending webhook event.');
        lines.push('# TYPE viva_webhook_event_oldest_pending_age_seconds gauge');
        lines.push(`viva_webhook_event_oldest_pending_age_seconds ${this._webhookOldestPendingAgeSeconds}`);
        lines.push('');
        // Counters
        for (const [name, byLabel] of this._counters) {
            const labelObjMap = this._counterLabels.get(name);
            lines.push(`# HELP ${name} Viva plugin counter.`);
            lines.push(`# TYPE ${name} counter`);
            for (const [key, value] of byLabel) {
                const labels = labelObjMap.get(key) ?? {};
                lines.push(`${name}${labelStr(labels)} ${value}`);
            }
            lines.push('');
        }
        // Histograms
        for (const [name, state] of this._histograms) {
            lines.push(`# HELP ${name} Viva ISV API call duration in seconds.`);
            lines.push(`# TYPE ${name} histogram`);
            for (const [key, bucketCounts] of state.counts) {
                const labels = state.labelMap.get(key) ?? {};
                for (let i = 0; i < exports.ISV_API_DURATION_BUCKETS.length; i++) {
                    const le = exports.ISV_API_DURATION_BUCKETS[i];
                    lines.push(`${name}_bucket${labelStr({ ...labels, le: String(le) })} ${bucketCounts[i] ?? 0}`);
                }
                lines.push(`${name}_bucket${labelStr({ ...labels, le: '+Inf' })} ${bucketCounts[exports.ISV_API_DURATION_BUCKETS.length] ?? 0}`);
                lines.push(`${name}_sum${labelStr(labels)} ${state.sum.get(key) ?? 0}`);
                lines.push(`${name}_count${labelStr(labels)} ${state.count.get(key) ?? 0}`);
            }
            lines.push('');
        }
        return lines.join('\n');
    }
};
exports.MetricsStateService = MetricsStateService;
exports.MetricsStateService = MetricsStateService = __decorate([
    (0, common_1.Injectable)()
], MetricsStateService);
//# sourceMappingURL=metrics-state.service.js.map