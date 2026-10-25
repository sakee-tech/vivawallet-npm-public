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

import { BlockList } from 'node:net';

// ---------------------------------------------------------------------------
// Published IP lists
// ---------------------------------------------------------------------------

/**
 * Viva demo-environment webhook source IPs.
 * All are literal IPv4 addresses (no CIDR ranges in the demo list).
 *
 * @see references/viva-docs/md/webhooks-for-payments.txt:289
 */
export const VIVA_DEMO_IPS: readonly string[] = [
  '20.50.240.57',
  '40.74.20.78',
  '195.167.87.181',
  '195.167.87.180',
  '20.13.195.185',
  '135.225.16.50',
] as const;

/**
 * Viva production-environment webhook source IPs (mix of literals and CIDRs).
 *
 * @see references/viva-docs/md/webhooks-for-payments.txt:276
 */
export const VIVA_PROD_IPS: readonly string[] = [
  '51.138.37.238',
  '13.80.70.181',
  '13.80.71.223',
  '13.79.28.70',
  '40.127.253.112/28',
  '51.105.129.192/28',
  '20.54.89.16',
  '4.223.76.50',
  '51.12.157.0/28',
] as const;

// ---------------------------------------------------------------------------
// BlockList builder
// ---------------------------------------------------------------------------

/**
 * Parse a single IP string or CIDR string and add it to a BlockList.
 * Supports:
 *   - Literal IPv4:  "1.2.3.4"
 *   - IPv4 CIDR:     "1.2.3.0/24"
 *   - Literal IPv6:  "::1"
 */
function addToBlockList(bl: BlockList, entry: string): void {
  const slash = entry.indexOf('/');
  if (slash !== -1) {
    const addr = entry.slice(0, slash);
    const prefix = parseInt(entry.slice(slash + 1), 10);
    // node:net BlockList.addSubnet(addr, prefix, type)
    bl.addSubnet(addr, prefix, addr.includes(':') ? 'ipv6' : 'ipv4');
  } else {
    bl.addAddress(entry, entry.includes(':') ? 'ipv6' : 'ipv4');
  }
}

/** Build a BlockList from an array of IP/CIDR strings. */
function buildBlockList(ips: readonly string[]): BlockList {
  const bl = new BlockList();
  for (const entry of ips) {
    addToBlockList(bl, entry);
  }
  return bl;
}

// Cached BlockLists built once per process.
const _demoList = buildBlockList(VIVA_DEMO_IPS);
const _prodList = buildBlockList(VIVA_PROD_IPS);

// ---------------------------------------------------------------------------
// Normaliser
// ---------------------------------------------------------------------------

/**
 * Normalise an IP string for comparison:
 * - Lowercase
 * - Strip surrounding brackets (e.g. `[::1]` → `::1`)
 */
function normaliseIp(ip: string): string {
  let s = ip.trim().toLowerCase();
  if (s.startsWith('[') && s.endsWith(']')) {
    s = s.slice(1, -1);
  }
  return s;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

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
export function isAllowedSourceIp(
  ip: string,
  env: 'demo' | 'production',
  extraAllowlist?: readonly string[],
): boolean {
  const normalised = normaliseIp(ip);
  const type = normalised.includes(':') ? 'ipv6' : 'ipv4';

  // Check the env-specific block list.
  const list = env === 'demo' ? _demoList : _prodList;
  if (list.check(normalised, type)) {
    return true;
  }

  // Check extra allowlist if provided.
  if (extraAllowlist && extraAllowlist.length > 0) {
    const extraList = buildBlockList(extraAllowlist);
    if (extraList.check(normalised, type)) {
      return true;
    }
  }

  return false;
}
