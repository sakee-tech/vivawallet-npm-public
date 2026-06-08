"use strict";
/**
 * route.ts — GET /viva/internal/metrics
 *
 * Admin-guarded Prometheus text format scrape endpoint.
 * Returns in-process metric counters and histograms from PromMetricsHook.
 *
 * Auth gate: same X-Viva-Admin-Token / VIVA_ADMIN_TOKEN as auth-status.
 *
 * @see references/viva-docs/md/isv-partner-program.txt:61 (P16 observability)
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.GET = void 0;
const node_crypto_1 = require("node:crypto");
const index_js_1 = require("../../../../observability/index.js");
// ---------------------------------------------------------------------------
// Admin token guard (same pattern as auth-status)
// ---------------------------------------------------------------------------
function isTokenValid(provided, expected) {
    if (provided.length !== expected.length)
        return false;
    return (0, node_crypto_1.timingSafeEqual)(Buffer.from(provided, 'utf-8'), Buffer.from(expected, 'utf-8'));
}
// ---------------------------------------------------------------------------
// GET handler
// ---------------------------------------------------------------------------
const GET = async (req, res) => {
    const adminToken = process.env['VIVA_ADMIN_TOKEN'];
    if (!adminToken) {
        res.status(401).json({
            error: 'unauthorized',
            reason: 'admin-token-not-configured',
        });
        return;
    }
    const provided = req.headers['x-viva-admin-token'];
    const providedStr = Array.isArray(provided) ? provided[0] : provided;
    if (!providedStr || !isTokenValid(providedStr, adminToken)) {
        res.status(401).json({ error: 'unauthorized' });
        return;
    }
    const exposition = (0, index_js_1.getSharedMetrics)().toExposition();
    res.setHeader('Content-Type', 'text/plain; version=0.0.4; charset=utf-8');
    res.setHeader('Cache-Control', 'no-store');
    res.status(200).send(exposition);
};
exports.GET = GET;
//# sourceMappingURL=route.js.map