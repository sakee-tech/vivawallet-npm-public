/**
 * Viva Wallet webhook source IP allowlist.
 *
 * Viva documents the following source IP addresses/ranges for webhook POST
 * requests. Only requests from these IPs should be processed; others are
 * rejected with 403 by the route handler.
 *
 * Production IPs (literal + CIDR):
 *   51.138.37.238
 *   13.80.70.181
 *   13.80.71.223
 *   13.79.28.70
 *   40.127.253.112/28
 *   51.105.129.192/28
 *   20.54.89.16
 *   4.223.76.50
 *   51.12.157.0/28
 *
 * Demo IPs (literal):
 *   20.50.240.57
 *   40.74.20.78
 *   195.167.87.181
 *   195.167.87.180
 *   20.13.195.185
 *   135.225.16.50
 *
 * @see references/viva-docs/md/webhooks-for-payments.txt:270
 */
/**
 * Viva demo-environment webhook source IPs.
 * All are literal IPv4 addresses (no CIDR ranges in the demo list).
 *
 * @see references/viva-docs/md/webhooks-for-payments.txt:289
 */
export declare const VIVA_DEMO_IPS: readonly string[];
/**
 * Viva production-environment webhook source IPs (mix of literals and CIDRs).
 *
 * @see references/viva-docs/md/webhooks-for-payments.txt:276
 */
export declare const VIVA_PROD_IPS: readonly string[];
/**
 * Returns `true` if `ip` is in Viva's published source list for `env`,
 * or if it appears in the optional `extraAllowlist`.
 *
 * Does NOT throw — the route handler decides whether to 403.
 *
 * IPv4 literals and CIDR ranges are matched via `node:net.BlockList`.
 * IPv6 is normalised (lowercase + bracket-strip) before checking.
 *
 * @param ip             The source IP of the incoming request.
 * @param env            Target environment: `'demo'` or `'production'`.
 * @param extraAllowlist Optional operator-configured IPs (e.g. reverse proxies
 *                       that sit upstream of Viva before reaching this server).
 *
 * @see references/viva-docs/md/webhooks-for-payments.txt:270
 */
export declare function isAllowedSourceIp(ip: string, env: 'demo' | 'production', extraAllowlist?: readonly string[]): boolean;
//# sourceMappingURL=ip-allowlist.d.ts.map