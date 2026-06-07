/**
 * _admin-auth.ts — shared admin-token gate for `/viva/admin/*` routes.
 *
 * Extracted in slice F so all admin routes share one timing-safe token check.
 * Behaviour is identical to the inline copies that previously lived in each
 * route file: reads `VIVA_ADMIN_TOKEN` from the process env, compares it
 * against the `x-viva-admin-token` request header using `timingSafeEqual`,
 * and writes a `401 { error: 'unauthorized' }` envelope on mismatch.
 *
 * When `VIVA_ADMIN_TOKEN` is unset the gate fails closed with
 * `{ error: 'unauthorized', reason: 'admin-token-not-configured' }` — same
 * envelope shape used by `/viva/internal/*` so the operator gets a clear
 * configuration hint without leaking whether a token was provided.
 *
 * @see docs/plans/multi-mode-v0.md §6 (admin REST table)
 */
import { timingSafeEqual } from 'node:crypto';
function isTokenValid(provided, expected) {
    if (provided.length !== expected.length)
        return false;
    return timingSafeEqual(Buffer.from(provided, 'utf-8'), Buffer.from(expected, 'utf-8'));
}
/**
 * Returns `true` and writes a 401 response when the admin token is missing
 * or invalid. Returns `false` when the request is authorized.
 *
 * Reads `VIVA_ADMIN_TOKEN` lazily from `process.env` so tests can swap it
 * between requests.
 */
export function reject401IfUnauthorized(req, res) {
    const adminToken = process.env['VIVA_ADMIN_TOKEN'];
    if (!adminToken) {
        res
            .status(401)
            .json({ error: 'unauthorized', reason: 'admin-token-not-configured' });
        return true;
    }
    const provided = req.headers['x-viva-admin-token'];
    const providedStr = Array.isArray(provided) ? provided[0] : provided;
    if (!providedStr || !isTokenValid(providedStr, adminToken)) {
        res.status(401).json({ error: 'unauthorized' });
        return true;
    }
    return false;
}
//# sourceMappingURL=_admin-auth.js.map