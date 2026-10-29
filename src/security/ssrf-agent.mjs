import https from 'node:https';
import tls from 'node:tls';
import dns from 'node:dns/promises';
import net from 'node:net';
import { SsrfBlockedError } from '../errors/base-error.mjs';
import { LIMITS } from '../config/limits.mjs';

/**
 * Checks if an IPv4 address belongs to a private, loopback, link-local, or reserved subnet.
 * @param {string} ip
 * @returns {boolean} True if IP is blocked.
 */
export function isBlockedIpv4(ip) {
  const parts = ip.split('.').map(Number);
  if (parts.length !== 4 || parts.some(Number.isNaN)) {
    return true;
  }

  const [a = 0, b = 0, c = 0] = parts;

  // 0.0.0.0/8 (Current network)
  if (a === 0) return true;
  // 127.0.0.0/8 (Loopback)
  if (a === 127) return true;
  // 10.0.0.0/8 (Private)
  if (a === 10) return true;
  // 172.16.0.0/12 (Private: 172.16.0.0 to 172.31.255.255)
  if (a === 172 && b >= 16 && b <= 31) return true;
  // 192.168.0.0/16 (Private)
  if (a === 192 && b === 168) return true;
  // 169.254.0.0/16 (Link-local & AWS/GCP/Azure Cloud Metadata 169.254.169.254)
  if (a === 169 && b === 254) return true;
  // 100.64.0.0/10 (Carrier-grade NAT)
  if (a === 100 && b >= 64 && b <= 127) return true;
  // 192.0.2.0/24, 198.51.100.0/24, 203.0.113.0/24 (Test-Net)
  if (a === 192 && b === 0 && c === 2) return true;
  if (a === 198 && b === 51 && c === 100) return true;
  if (a === 203 && b === 0 && c === 113) return true;
  // 224.0.0.0/4 (Multicast)
  if (a >= 224 && a <= 239) return true;
  // 240.0.0.0/4 (Reserved)
  if (a >= 240) return true;

  return false;
}

/**
 * Checks if an IPv6 address belongs to a private, loopback, or unique local range.
 * @param {string} ip
 * @returns {boolean} True if IP is blocked.
 */
export function isBlockedIpv6(ip) {
  const normalized = ip.toLowerCase().trim();

  // ::1 (Loopback)
  if (normalized === '::1' || normalized === '0:0:0:0:0:0:0:1') return true;
  // :: (Unspecified)
  if (normalized === '::' || normalized === '0:0:0:0:0:0:0:0') return true;
  // fc00::/7 & fd00::/8 (Unique Local Address)
  if (normalized.startsWith('fc') || normalized.startsWith('fd')) return true;
  // fe80::/10 (Link-Local)
  if (normalized.startsWith('fe8') || normalized.startsWith('fe9') || normalized.startsWith('fea') || normalized.startsWith('feb')) return true;
  // IPv4-mapped IPv6 (::ffff:127.0.0.1, etc.)
  if (normalized.startsWith('::ffff:')) {
    const ipv4Part = normalized.replace('::ffff:', '');
    if (net.isIPv4(ipv4Part)) {
      return isBlockedIpv4(ipv4Part);
    }
  }

  return false;
}

/**
 * Validates that an IP address is a safe public routable destination.
 * @param {string} ip
 * @returns {boolean}
 */
export function isSafePublicIp(ip) {
  const family = net.isIP(ip);
  if (family === 4) {
    return !isBlockedIpv4(ip);
  }
  if (family === 6) {
    return !isBlockedIpv6(ip);
  }
  return false;
}

/**
 * Custom HTTPS Agent implementing Connection-Time DNS Pinning SSRF Protection (ADR-06).
 */
export class SsrfGuardedHttpsAgent extends https.Agent {
  /**
   * @param {https.AgentOptions} [options={}]
   */
  constructor(options = {}) {
    super({
      keepAlive: false,
      maxSockets: 50,
      ...options,
    });
  }

  /**
   * Overrides createConnection to resolve DNS, filter against blacklists, and pin TCP/TLS socket directly.
   * @param {any} options
   * @param {Function} callback
   */
  /**
   * Overrides createConnection to resolve DNS, filter against blacklists, and pin TCP/TLS socket directly.
   * @param {any} options
   * @param {((err: Error | null, stream?: any) => void)} [callback]
   * @returns {any}
   */
  createConnection(options, callback) {
    const host = options.hostname || options.host;
    const port = options.port || 443;

    // Asynchronously resolve DNS with strict timeout
    (async () => {
      try {
        let targetIp = host;

        if (!net.isIP(host)) {
          const timeoutPromise = new Promise((_, reject) => {
            setTimeout(() => reject(new Error('DNS resolution timed out')), LIMITS.DNS_LOOKUP_TIMEOUT_MS);
          });

          // Resolve all A and AAAA records
          const lookupPromise = dns.lookup(host, { all: true });
          const records = /** @type {Array<{ address: string, family: number }>} */ (await Promise.race([lookupPromise, timeoutPromise]));

          if (!records || records.length === 0) {
            throw new Error(`DNS lookup for host '${host}' returned zero records.`);
          }

          // Check EVERY resolved address; fail closed if any resolves to private IP
          for (const record of records) {
            if (!isSafePublicIp(record.address)) {
              if (process.env.ALLOW_LOCAL_DISPATCH === 'true' && (record.address === '127.0.0.1' || record.address === '::1')) {
                continue;
              }
              throw new SsrfBlockedError(
                `https://${host}:${port}`,
                record.address,
                'Host resolved to a blocked private, loopback, or metadata address.',
              );
            }
          }

          // Pin to the first validated public IP
          const firstRecord = records[0];
          if (!firstRecord) {
            throw new Error(`No DNS records returned for '${host}'.`);
          }
          targetIp = firstRecord.address;
        } else {
          // Direct IP provided
          if (!isSafePublicIp(host)) {
            if (process.env.ALLOW_LOCAL_DISPATCH === 'true' && (host === '127.0.0.1' || host === '::1')) {
              // Allowed in local test dispatch
            } else {
              throw new SsrfBlockedError(
                `https://${host}:${port}`,
                host,
                'Direct IP destination belongs to a blocked private, loopback, or metadata range.',
              );
            }
          }
        }

        // Establish TLS connection pinned directly to validated public IP
        const socket = tls.connect({
          host: targetIp,
          port,
          servername: host, // SNI preserved for virtual hosting
          rejectUnauthorized: process.env.ALLOW_LOCAL_DISPATCH === 'true' ? false : true,
          ...options,
        });

        if (callback) {
          callback(null, socket);
        }
      } catch (err) {
        if (callback) {
          callback(err instanceof Error ? err : new Error(String(err)));
        }
      }
    })();
  }
}

export const ssrfAgent = new SsrfGuardedHttpsAgent();
