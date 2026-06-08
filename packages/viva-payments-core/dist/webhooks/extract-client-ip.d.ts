/**
 * extract-client-ip.ts — Source IP extraction with explicit proxy-depth trust.
 *
 * CSO Finding #2 (HIGH). Unconditionally trusting `X-Forwarded-For` lets any
 * client append a value and bypass the in-app IP allowlist. The remedy is to
 * walk the X-F-F chain from the *rightmost* end, counting back exactly
 * `trustedProxyDepth` hops. Anything earlier in the chain was set by upstream
 * proxies the operator does not control.
 *
 * Usage:
 *   trustedProxyDepth = 0 → ignore X-F-F entirely; use req.socket.remoteAddress
 *   trustedProxyDepth = 1 → one trusted reverse proxy (typical)
 *   trustedProxyDepth = 2 → CDN + LB (e.g. Cloudflare → ALB)
 *
 * When the chain is shorter than `trustedProxyDepth`, the request is treated
 * as misconfigured or malicious: we fall back to the socket address rather
 * than picking an attacker-controllable value.
 *
 * @see docs/TODO-CSO.md "Finding 2"
 */
import type { IncomingMessage } from 'node:http';
/**
 * Minimal request shape — accepts Node's IncomingMessage and any framework
 * request that exposes headers + socket (Medusa, Express, NestJS, etc.).
 */
export interface ClientIpRequest {
    readonly headers: IncomingMessage['headers'];
    readonly socket?: {
        readonly remoteAddress?: string | undefined;
    } | undefined;
}
/**
 * Extract the trusted client IP from a request.
 *
 * Returns an empty string if no source can be determined (caller decides
 * whether to reject or fall back to a default). Strips IPv6 brackets if
 * present (e.g. `[2001:db8::1]:443` → `2001:db8::1`).
 */
export declare function extractClientIp(req: ClientIpRequest, trustedProxyDepth: number): string;
//# sourceMappingURL=extract-client-ip.d.ts.map