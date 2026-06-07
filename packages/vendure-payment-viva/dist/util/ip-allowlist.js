/**
 * util/ip-allowlist.ts — IP allowlist helpers for the webhook receiver.
 *
 * Viva Wallet does not sign webhook bodies (no HMAC). Instead it publishes
 * a set of source IPs/CIDRs that all webhook POSTs will originate from.
 * We reject anything outside the allowlist.
 *
 * Source: references/viva-docs/md/webhooks-for-payments.txt lines 272–301.
 *
 * @see docs/plans/vendure-plugin-v0.md §D16
 * @see docs/VENDURE-CONTRACT.MD §4 "Webhook receiver"
 */
import { extractClientIp } from '@sakeetech/viva-payments-core/webhooks';
// ---------------------------------------------------------------------------
// Viva's published CIDRs (webhooks-for-payments.txt lines 274–301)
// ---------------------------------------------------------------------------
/**
 * Production IP allowlist.
 * Source: webhooks-for-payments.txt lines 276–287.
 */
const VIVA_PRODUCTION_IPS = [
    '51.138.37.238',
    '13.80.70.181',
    '13.80.71.223',
    '13.79.28.70',
    '40.127.253.112/28',
    '51.105.129.192/28',
    '20.54.89.16',
    '4.223.76.50',
    '51.12.157.0/28',
];
/**
 * Demo IP allowlist.
 * Source: webhooks-for-payments.txt lines 291–301.
 */
const VIVA_DEMO_IPS = [
    '20.50.240.57',
    '40.74.20.78',
    '195.167.87.181',
    '195.167.87.180',
    '20.13.195.185',
    '135.225.16.50',
];
/**
 * Default allowlist = demo + production combined.
 * A single deployment receives both (environment flag is for outbound calls only).
 */
export const DEFAULT_VIVA_IP_ALLOWLIST = [
    ...VIVA_PRODUCTION_IPS,
    ...VIVA_DEMO_IPS,
];
// ---------------------------------------------------------------------------
// CIDR / IP parsing helpers (zero-dep)
// ---------------------------------------------------------------------------
/**
 * Parse an IPv4 address string into a 32-bit unsigned integer.
 * Returns NaN on malformed input.
 */
function ipv4ToInt(ip) {
    const parts = ip.trim().split('.');
    if (parts.length !== 4)
        return NaN;
    let result = 0;
    for (const part of parts) {
        const n = Number(part);
        if (!Number.isInteger(n) || n < 0 || n > 255)
            return NaN;
        result = (result << 8) | n;
    }
    // Force unsigned 32-bit.
    return result >>> 0;
}
/**
 * Check whether `ip` falls within the CIDR block `cidr`.
 * Handles both single-host notation (`"1.2.3.4"`) and range notation
 * (`"1.2.3.0/24"`).
 */
function isInCidr(ip, cidr) {
    const slashIdx = cidr.indexOf('/');
    if (slashIdx === -1) {
        // Single IP comparison.
        return ip.trim() === cidr.trim();
    }
    const networkIp = cidr.slice(0, slashIdx);
    const prefixLen = Number(cidr.slice(slashIdx + 1));
    if (!Number.isInteger(prefixLen) || prefixLen < 0 || prefixLen > 32)
        return false;
    const ipInt = ipv4ToInt(ip);
    const netInt = ipv4ToInt(networkIp);
    if (isNaN(ipInt) || isNaN(netInt))
        return false;
    if (prefixLen === 0)
        return true; // 0.0.0.0/0 = all
    const mask = prefixLen === 32 ? 0xffffffff : ~((1 << (32 - prefixLen)) - 1);
    const maskU = mask >>> 0;
    return (ipInt & maskU) === (netInt & maskU);
}
// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------
/**
 * Determine whether the given source IP is permitted by the allowlist.
 *
 * Allowlist behaviour:
 * - `false`      → allowlist disabled (dev/test convenience); always returns true.
 * - `[]`         → empty list; behaves the same as disabled (always true) so that
 *                  accidentally passing an empty array doesn't lock out every call.
 * - `undefined`  → use Viva's published demo + production CIDRs.
 * - `string[]`   → custom list; enforce it.
 *
 * Each entry may be a single IPv4 address or an IPv4 CIDR range.
 */
export function isIpAllowed(sourceIp, allowlist) {
    // Disabled check — dev/test bypass.
    if (allowlist === false || (Array.isArray(allowlist) && allowlist.length === 0)) {
        return true;
    }
    const list = allowlist ?? DEFAULT_VIVA_IP_ALLOWLIST;
    for (const entry of list) {
        if (isInCidr(sourceIp, entry))
            return true;
    }
    return false;
}
/**
 * Extract the source IP from an incoming request.
 *
 * Delegates to the core `extractClientIp` helper which walks `X-Forwarded-For`
 * from the **rightmost** end, counting back `trustedProxyDepth` hops. The old
 * "take leftmost X-F-F" behaviour was vulnerable to header spoofing (CSO
 * Finding #2); see `docs/TODO-CSO.md`.
 *
 * @param trustedProxyDepth — number of trailing X-F-F hops set by trusted
 *   proxies. 0 = ignore X-F-F (use socket); 1 = one reverse proxy; 2 = CDN+LB.
 */
export function getSourceIp(req, trustedProxyDepth = 0) {
    return extractClientIp(req, trustedProxyDepth);
}
//# sourceMappingURL=ip-allowlist.js.map