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
import type { IncomingMessage } from 'node:http';
/**
 * Default allowlist = demo + production combined.
 * A single deployment receives both (environment flag is for outbound calls only).
 */
export declare const DEFAULT_VIVA_IP_ALLOWLIST: string[];
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
export declare function isIpAllowed(sourceIp: string, allowlist: string[] | false | undefined): boolean;
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
export declare function getSourceIp(req: IncomingMessage, trustedProxyDepth?: number): string;
//# sourceMappingURL=ip-allowlist.d.ts.map