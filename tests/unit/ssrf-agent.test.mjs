import test from 'node:test';
import assert from 'node:assert/strict';
import { isBlockedIpv4, isBlockedIpv6, isSafePublicIp } from '../../src/security/ssrf-agent.mjs';

test('isBlockedIpv4 detects all private, loopback, link-local, and reserved IPv4 subnets', () => {
  // Loopback (TC-23)
  assert.equal(isBlockedIpv4('127.0.0.1'), true);
  assert.equal(isBlockedIpv4('127.255.255.254'), true);

  // Cloud metadata & Link-Local (TC-24)
  assert.equal(isBlockedIpv4('169.254.169.254'), true);
  assert.equal(isBlockedIpv4('169.254.1.1'), true);

  // RFC 1918 Private Ranges (TC-25)
  assert.equal(isBlockedIpv4('10.0.0.1'), true);
  assert.equal(isBlockedIpv4('10.254.254.254'), true);
  assert.equal(isBlockedIpv4('172.16.0.1'), true);
  assert.equal(isBlockedIpv4('172.31.255.255'), true);
  assert.equal(isBlockedIpv4('192.168.1.1'), true);
  assert.equal(isBlockedIpv4('192.168.100.50'), true);

  // Current network & CGNAT
  assert.equal(isBlockedIpv4('0.0.0.0'), true);
  assert.equal(isBlockedIpv4('100.64.0.1'), true);

  // Multicast & Reserved
  assert.equal(isBlockedIpv4('224.0.0.1'), true);
  assert.equal(isBlockedIpv4('240.0.0.1'), true);

  // Valid Public IP addresses
  assert.equal(isBlockedIpv4('8.8.8.8'), false);
  assert.equal(isBlockedIpv4('1.1.1.1'), false);
  assert.equal(isBlockedIpv4('93.184.216.34'), false);
});

test('isBlockedIpv6 detects IPv6 loopback, link-local, unique-local, and IPv4-mapped addresses', () => {
  // Loopback & Unspecified
  assert.equal(isBlockedIpv6('::1'), true);
  assert.equal(isBlockedIpv6('::'), true);

  // Unique Local (fc00::/7)
  assert.equal(isBlockedIpv6('fc00::1'), true);
  assert.equal(isBlockedIpv6('fd12:3456:789a::1'), true);

  // Link-Local (fe80::/10)
  assert.equal(isBlockedIpv6('fe80::1'), true);

  // IPv4-mapped private IPv6
  assert.equal(isBlockedIpv6('::ffff:127.0.0.1'), true);
  assert.equal(isBlockedIpv6('::ffff:169.254.169.254'), true);
  assert.equal(isBlockedIpv6('::ffff:10.0.0.5'), true);

  // Valid Public IPv6
  assert.equal(isBlockedIpv6('2001:4860:4860::8888'), false);
  assert.equal(isBlockedIpv6('2606:4700:4700::1111'), false);
});

test('isSafePublicIp returns true only for public routable IPs', () => {
  assert.equal(isSafePublicIp('8.8.8.8'), true);
  assert.equal(isSafePublicIp('127.0.0.1'), false);
  assert.equal(isSafePublicIp('169.254.169.254'), false);
  assert.equal(isSafePublicIp('::1'), false);
  assert.equal(isSafePublicIp('invalid-ip-string'), false);
});
