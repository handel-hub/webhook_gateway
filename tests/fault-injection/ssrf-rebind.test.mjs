import test from 'node:test';
import assert from 'node:assert/strict';
import { isSafePublicIp, isBlockedIpv4, isBlockedIpv6, ssrfAgent } from '../../src/security/ssrf-agent.mjs';

test('SSRF Defense (TC-36): Blocks DNS rebinding to AWS metadata service and loopback', () => {
  // AWS / Cloud instance metadata
  assert.equal(isSafePublicIp('169.254.169.254'), false);
  assert.equal(isBlockedIpv4('169.254.169.254'), true);

  // Loopback variants
  assert.equal(isSafePublicIp('127.0.0.1'), false);
  assert.equal(isSafePublicIp('127.0.0.2'), false);
  assert.equal(isSafePublicIp('127.255.255.255'), false);
  assert.equal(isSafePublicIp('::1'), false);
  assert.equal(isBlockedIpv6('::1'), true);

  // IPv4-mapped IPv6 loopback (delimiter bypass attempt)
  assert.equal(isSafePublicIp('::ffff:127.0.0.1'), false);
  assert.equal(isBlockedIpv6('::ffff:127.0.0.1'), true);

  // RFC 1918 Private networks
  assert.equal(isSafePublicIp('10.0.0.1'), false);
  assert.equal(isSafePublicIp('172.16.0.1'), false);
  assert.equal(isSafePublicIp('192.168.1.1'), false);

  // RFC 4193 Unique Local IPv6
  assert.equal(isSafePublicIp('fc00::1'), false);
  assert.equal(isSafePublicIp('fd12:3456:789a::1'), false);

  // Valid public routable IPs
  assert.equal(isSafePublicIp('8.8.8.8'), true);
  assert.equal(isSafePublicIp('1.1.1.1'), true);
  assert.equal(isSafePublicIp('2607:f8b0:4005:805::200e'), true); // Google public IPv6
});

test('SSRF Agent: createConnection rejects destination resolving to private IP', async () => {
  assert.ok(typeof ssrfAgent.createConnection === 'function');

  // Attempting to connect to loopback via SSRF agent options
  const options = {
    host: '127.0.0.1',
    port: 443,
  };

  await assert.rejects(
    () =>
      new Promise((resolve, reject) => {
        ssrfAgent.createConnection(options, (err) => {
          if (err) return reject(err);
          resolve(undefined);
        });
      }),
    (err) => {
      assert.ok(err instanceof Error);
      assert.ok(err.message.includes('SSRF') || err.message.includes('blocked'));
      return true;
    },
  );
});
