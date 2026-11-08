"use strict";
/**
 * route.ts — GET /viva/webhook/health
 *
 * Liveness probe. No auth. Returns 200 { ok: true, environment, timestamp }.
 *
 * @see references/viva-docs/md/isv-partner-program.txt:61 (P16 health endpoints)
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.GET = void 0;
/**
 * GET /viva/webhook/health
 *
 * Returns 200 { ok: true } unconditionally.
 * Cache-Control: no-store to prevent proxy caching.
 */
const GET = async (_req, res) => {
    const environment = process.env['VIVA_ENVIRONMENT'] ?? 'demo';
    res.setHeader('Cache-Control', 'no-store');
    res.status(200).json({
        ok: true,
        environment,
        timestamp: new Date().toISOString(),
    });
};
exports.GET = GET;
//# sourceMappingURL=route.js.map