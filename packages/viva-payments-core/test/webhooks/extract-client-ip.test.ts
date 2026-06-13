/**
 * extract-client-ip.test.ts — Unit tests for source-IP extraction.
 *
 * Covers CSO Finding #2 (HIGH): trustedProxyDepth-bounded X-Forwarded-For
 * walking. The exploit being prevented is leftmost-X-F-F trust, which lets
 * any client claim to be a whitelisted Viva IP.
 *
 * @see docs/TODO-CSO.md "Finding 2"
 */

import { describe, it, expect } from 'vitest';

import {
  extractClientIp,
  type ClientIpRequest,
} from '../../src/webhooks/extract-client-ip.js';

function makeReq(opts: {
  socket?: string;
  xff?: string | string[];
}): ClientIpRequest {
  return {
    headers: opts.xff !== undefined ? { 'x-forwarded-for': opts.xff } : {},
    socket: opts.socket !== undefined ? { remoteAddress: opts.socket } : undefined,
  };
}

describe('extractClientIp', () => {
  describe('depth = 0 (no proxy)', () => {
    it('returns socket address; ignores X-F-F entirely', () => {
      const req = makeReq({ socket: '10.0.0.1', xff: '51.138.37.238, 10.0.0.99' });
      expect(extractClientIp(req, 0)).toBe('10.0.0.1');
    });

    it('returns empty string when socket is missing', () => {
      const req = makeReq({ xff: '51.138.37.238' });
      expect(extractClientIp(req, 0)).toBe('');
    });

    it('strips IPv6-mapped IPv4 prefix', () => {
      const req = makeReq({ socket: '::ffff:1.2.3.4' });
      expect(extractClientIp(req, 0)).toBe('1.2.3.4');
    });
  });

  describe('depth = 1 (one trusted proxy)', () => {
    it('returns rightmost X-F-F entry (the address our LB observed)', () => {
      const req = makeReq({
        socket: '10.0.0.1',
        xff: 'attacker-spoof, 51.138.37.238',
      });
      expect(extractClientIp(req, 1)).toBe('51.138.37.238');
    });

    it('with chain of length 1, returns that single entry', () => {
      const req = makeReq({ socket: '10.0.0.1', xff: '51.138.37.238' });
      expect(extractClientIp(req, 1)).toBe('51.138.37.238');
    });

    it('with empty chain, falls back to socket (does NOT trust X-F-F absence)', () => {
      const req = makeReq({ socket: '10.0.0.1' });
      expect(extractClientIp(req, 1)).toBe('10.0.0.1');
    });
  });

  describe('depth = 2 (CDN + LB)', () => {
    it('returns the second-from-right entry', () => {
      const req = makeReq({
        socket: '10.0.0.1',
        // chain: client, cloudflare, ALB
        xff: 'client-claim, 51.138.37.238, 10.0.0.5',
      });
      expect(extractClientIp(req, 2)).toBe('51.138.37.238');
    });

    it('with chain shorter than depth, falls back to socket', () => {
      // Attacker omits an expected hop to push a forged value into the trusted slot.
      const req = makeReq({ socket: '10.0.0.1', xff: '51.138.37.238' });
      expect(extractClientIp(req, 2)).toBe('10.0.0.1');
    });
  });

  describe('attacker spoofing scenarios', () => {
    it('depth=0 ignores attacker-set X-F-F entirely', () => {
      const req = makeReq({
        socket: '203.0.113.42',
        xff: '51.138.37.238',
      });
      expect(extractClientIp(req, 0)).toBe('203.0.113.42');
    });

    it('depth=1 picks rightmost (LB-set) value, not leftmost (attacker-set)', () => {
      // Attacker sets X-F-F themselves; LB appends the real client IP.
      const req = makeReq({
        socket: '10.0.0.1',
        xff: '51.138.37.238, 203.0.113.42', // attacker-claim, real-client
      });
      expect(extractClientIp(req, 1)).toBe('203.0.113.42');
    });
  });

  describe('header format edge cases', () => {
    it('handles multiple X-F-F header instances as comma-joined chain', () => {
      const req = makeReq({
        socket: '10.0.0.1',
        xff: ['client, cdn', 'lb'],
      });
      expect(extractClientIp(req, 1)).toBe('lb');
      expect(extractClientIp(req, 2)).toBe('cdn');
    });

    it('trims whitespace around entries', () => {
      const req = makeReq({
        socket: '10.0.0.1',
        xff: '  10.0.0.5  ,   51.138.37.238   ',
      });
      expect(extractClientIp(req, 1)).toBe('51.138.37.238');
    });

    it('filters empty entries from trailing commas', () => {
      const req = makeReq({
        socket: '10.0.0.1',
        xff: '51.138.37.238,,',
      });
      expect(extractClientIp(req, 1)).toBe('51.138.37.238');
    });

    it('strips bracketed IPv6 with port', () => {
      const req = makeReq({ socket: '[2001:db8::1]:443' });
      expect(extractClientIp(req, 0)).toBe('2001:db8::1');
    });

    it('passes through bare IPv6 unchanged', () => {
      const req = makeReq({ socket: '2001:db8::1' });
      expect(extractClientIp(req, 0)).toBe('2001:db8::1');
    });
  });

  describe('input sanitization', () => {
    it('negative depth clamps to 0 (socket only)', () => {
      const req = makeReq({ socket: '10.0.0.1', xff: '51.138.37.238' });
      expect(extractClientIp(req, -5)).toBe('10.0.0.1');
    });

    it('non-integer depth clamps to 0', () => {
      const req = makeReq({ socket: '10.0.0.1', xff: '51.138.37.238' });
      expect(extractClientIp(req, 1.5)).toBe('10.0.0.1');
      expect(extractClientIp(req, NaN)).toBe('10.0.0.1');
    });
  });
});
