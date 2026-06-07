/**
 * route.ts — GET /viva/internal/auth-status
 *
 * Admin-guarded endpoint. Returns current OAuth2 token expiry state for
 * readiness checks and debugging.
 *
 * Auth gate: constant-time comparison of X-Viva-Admin-Token header against
 * VIVA_ADMIN_TOKEN env var. 401 if missing or mismatch.
 *
 * Design decision: using env-var shared secret rather than Medusa admin auth
 * because this route is accessed by ops tooling (healthcheck scripts, monitoring
 * agents) that may not have a Medusa admin session. VIVA_ADMIN_TOKEN is rotated
 * independently via secrets manager. Document this choice for operators.
 *
 * @see references/viva-docs/md/isv-partner-program.txt:61 (P16 health endpoints)
 */
import { timingSafeEqual } from 'node:crypto';
import { VIVA_OAUTH2_STRATEGY_KEY } from '../../../../loaders/viva-oauth2-strategy.js';
// ---------------------------------------------------------------------------
// Admin token guard
// ---------------------------------------------------------------------------
/**
 * Constant-time comparison of two strings.
 * Returns false immediately if lengths differ (avoids timing side-channel on length).
 */
function isTokenValid(provided, expected) {
    if (provided.length !== expected.length)
        return false;
    return timingSafeEqual(Buffer.from(provided, 'utf-8'), Buffer.from(expected, 'utf-8'));
}
// ---------------------------------------------------------------------------
// GET handler
// ---------------------------------------------------------------------------
export const GET = async (req, res) => {
    const adminToken = process.env['VIVA_ADMIN_TOKEN'];
    // If VIVA_ADMIN_TOKEN is not configured: always deny, document reason.
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
    // ---- Read token cache state from the singleton strategy ----
    const environment = process.env['VIVA_ENVIRONMENT'] ?? 'demo';
    let tokenExpiresAt = null;
    let lastRefreshAt = null;
    let tokenPresent = false;
    try {
        // Resolve the singleton OAuth2 strategy registered by the plugin loader.
        // Using allowUnregistered so the route degrades gracefully when the loader
        // hasn't run (e.g. bare test environments without full Medusa bootstrap).
        const strategy = req.scope?.resolve(VIVA_OAUTH2_STRATEGY_KEY, { allowUnregistered: true });
        if (strategy) {
            const cache = strategy.tokenCache;
            const clientId = process.env['VIVA_ISV_CLIENT_ID'] ?? '';
            const cacheKey = `viva:isv:token:${clientId}:${environment}`;
            const cached = await cache.get(cacheKey);
            if (cached) {
                tokenPresent = true;
                tokenExpiresAt = new Date(cached.expires_at).toISOString();
                // last_refresh_at: approximate — expires_at - (3600 - 60) seconds = expires_at - 3540s
                // The cache stores expires_at = now_at_refresh + 3600000 - 60000.
                // We can approximate refresh time = expires_at - 3540000ms.
                lastRefreshAt = new Date(cached.expires_at - 3540 * 1000).toISOString();
            }
        }
    }
    catch {
        // Strategy not available — return what we can
    }
    res.setHeader('Cache-Control', 'no-store');
    res.status(200).json({
        environment,
        token_present: tokenPresent,
        token_expires_at: tokenExpiresAt,
        last_refresh_at: lastRefreshAt,
        now: new Date().toISOString(),
    });
};
//# sourceMappingURL=route.js.map