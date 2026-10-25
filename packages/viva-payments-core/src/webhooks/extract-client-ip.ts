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
  readonly socket?: { readonly remoteAddress?: string | undefined } | undefined;
}

/**
 * Extract the trusted client IP from a request.
 *
 * Returns an empty string if no source can be determined (caller decides
 * whether to reject or fall back to a default). Strips IPv6 brackets if
 * present (e.g. `[2001:db8::1]:443` → `2001:db8::1`).
 */
export function extractClientIp(
  req: ClientIpRequest,
  trustedProxyDepth: number,
): string {
  const depth = Number.isInteger(trustedProxyDepth) && trustedProxyDepth >= 0
    ? trustedProxyDepth
    : 0;

  if (depth === 0) {
    return normalizeIp(req.socket?.remoteAddress ?? '');
  }

  const xff = req.headers['x-forwarded-for'];
  const chain = flattenXff(xff);

  if (chain.length < depth) {
    // Chain shorter than configured trust depth — operator misconfig or an
    // attacker omitting expected hops. Fall back to socket; do NOT pick the
    // leftmost (attacker-controllable) value.
    return normalizeIp(req.socket?.remoteAddress ?? '');
  }

  return normalizeIp(chain[chain.length - depth] ?? '');
}

function flattenXff(
  xff: string | string[] | undefined,
): readonly string[] {
  if (!xff) return [];
  // Node may surface repeated headers as either a comma-joined string or an
  // array of strings; normalize both into one comma-separated source.
  const joined = Array.isArray(xff) ? xff.join(',') : xff;
  return joined
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

function normalizeIp(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed) return '';
  // IPv6-mapped IPv4 (::ffff:1.2.3.4) → 1.2.3.4
  if (trimmed.toLowerCase().startsWith('::ffff:')) {
    return trimmed.slice(7);
  }
  // Bracketed IPv6 with optional :port — [2001:db8::1]:443 → 2001:db8::1
  if (trimmed.startsWith('[')) {
    const close = trimmed.indexOf(']');
    if (close > 0) return trimmed.slice(1, close);
  }
  return trimmed;
}
