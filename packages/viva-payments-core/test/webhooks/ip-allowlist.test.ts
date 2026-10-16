import { describe, it, expect } from 'vitest';
import { isAllowedSourceIp, VIVA_DEMO_IPS, VIVA_PROD_IPS } from '../../src/webhooks/ip-allowlist.js';

describe('isAllowedSourceIp', () => {
  // Pick representative IPs from the published lists.
  const demoIp = '20.50.240.57';   // VIVA_DEMO_IPS[0] — literal
  const prodIp = '51.138.37.238';  // VIVA_PROD_IPS[0] — literal
  const prodCidrMember = '40.127.253.112'; // first address in 40.127.253.112/28

  it('allows a demo IP in demo env', () => {
    expect(isAllowedSourceIp(demoIp, 'demo')).toBe(true);
  });

  it('denies a demo IP in production env', () => {
    expect(isAllowedSourceIp(demoIp, 'production')).toBe(false);
  });

  it('allows a prod IP in production env', () => {
    expect(isAllowedSourceIp(prodIp, 'production')).toBe(true);
  });

  it('denies a prod IP in demo env', () => {
    expect(isAllowedSourceIp(prodIp, 'demo')).toBe(false);
  });

  it('allows a CIDR member IP in production env', () => {
    // 40.127.253.112/28 covers .112–.127
    expect(isAllowedSourceIp(prodCidrMember, 'production')).toBe(true);
  });

  it('denies a random IP in both envs', () => {
    const randomIp = '1.2.3.4';
    expect(isAllowedSourceIp(randomIp, 'demo')).toBe(false);
    expect(isAllowedSourceIp(randomIp, 'production')).toBe(false);
  });

  it('allows an IP in the extraAllowlist', () => {
    const operatorIp = '10.0.0.1';
    expect(isAllowedSourceIp(operatorIp, 'production', ['10.0.0.1'])).toBe(true);
    // Without extra allowlist, it is denied.
    expect(isAllowedSourceIp(operatorIp, 'production')).toBe(false);
  });

  it('allows an IP from an extraAllowlist CIDR', () => {
    expect(isAllowedSourceIp('192.168.1.5', 'demo', ['192.168.1.0/24'])).toBe(true);
    expect(isAllowedSourceIp('192.168.2.1', 'demo', ['192.168.1.0/24'])).toBe(false);
  });

  it('normalises IPv6: strips surrounding brackets', () => {
    // [::1] and ::1 should be equivalent.
    // Neither is a Viva IP — both should deny. But bracket-stripping should
    // not crash, and extra allowlist test covers normalisation.
    expect(isAllowedSourceIp('[::1]', 'demo', ['::1'])).toBe(true);
    expect(isAllowedSourceIp('::1', 'demo', ['::1'])).toBe(true);
    expect(isAllowedSourceIp('[::1]', 'demo', ['::2'])).toBe(false);
  });

  it('VIVA_DEMO_IPS and VIVA_PROD_IPS are non-empty readonly arrays', () => {
    expect(VIVA_DEMO_IPS.length).toBeGreaterThan(0);
    expect(VIVA_PROD_IPS.length).toBeGreaterThan(0);
  });
});
