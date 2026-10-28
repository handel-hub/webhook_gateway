import http from 'node:http';
import { createLogger } from './logger.mjs';

const logger = createLogger({ service: 'metrics' });

/**
 * @typedef {object} MetricDefinition
 * @property {string} name
 * @property {'counter' | 'gauge'} type
 * @property {string} help
 */

/**
 * Zero-dependency Prometheus Metrics Registry.
 */
class MetricsRegistry {
  constructor() {
    /** @type {Map<string, MetricDefinition>} */
    this.definitions = new Map();
    /** @type {Map<string, number>} */
    this.values = new Map();

    this.registerStandardMetrics();
  }

  /**
   * Registers a metric definition with help and type.
   * @param {string} name
   * @param {'counter' | 'gauge'} type
   * @param {string} help
   */
  register(name, type, help) {
    this.definitions.set(name, { name, type, help });
  }

  registerStandardMetrics() {
    this.register('cwids_ingress_requests_total', 'counter', 'Total number of inbound webhook requests');
    this.register('cwids_signature_verification_failures_total', 'counter', 'Total signature verification rejections');
    this.register('cwids_queue_depth_pending', 'gauge', 'Current count of pending deliveries in work queue');
    this.register('cwids_delivery_attempts_total', 'counter', 'Total outbound delivery HTTP attempts');
    this.register('cwids_circuit_breaker_state', 'gauge', 'Circuit breaker state per endpoint (0=closed, 1=half_open, 2=open)');
    this.register('cwids_lease_expirations_recovered_total', 'counter', 'Total expired worker leases recovered');
  }

  /**
   * Serializes labels to key="val" string.
   * @param {Record<string, string | number>} labels
   * @returns {string}
   */
  formatLabels(labels = {}) {
    const entries = Object.entries(labels);
    if (entries.length === 0) return '';
    const formatted = entries
      .map(([k, v]) => `${k}="${String(v).replace(/"/g, '\\"')}"`)
      .join(',');
    return `{${formatted}}`;
  }

  /**
   * Generates internal composite key.
   * @param {string} name
   * @param {Record<string, string | number>} labels
   * @returns {string}
   */
  getKey(name, labels = {}) {
    const labelStr = this.formatLabels(labels);
    return `${name}${labelStr}`;
  }

  /**
   * Increments a counter metric.
   * @param {string} name
   * @param {Record<string, string | number>} [labels={}]
   * @param {number} [val=1]
   */
  increment(name, labels = {}, val = 1) {
    const key = this.getKey(name, labels);
    const current = this.values.get(key) ?? 0;
    this.values.set(key, current + val);
  }

  /**
   * Sets a gauge metric value.
   * @param {string} name
   * @param {Record<string, string | number>} [labels={}]
   * @param {number} val
   */
  setGauge(name, labels = {}, val = 0) {
    const key = this.getKey(name, labels);
    this.values.set(key, val);
  }

  /**
   * Generates Prometheus text exposition format string.
   * @returns {string}
   */
  toPrometheusText() {
    const lines = [];

    for (const [name, def] of this.definitions.entries()) {
      lines.push(`# HELP ${name} ${def.help}`);
      lines.push(`# TYPE ${name} ${def.type}`);

      let found = false;
      for (const [key, value] of this.values.entries()) {
        if (key === name || key.startsWith(`${name}{`)) {
          lines.push(`${key} ${value}`);
          found = true;
        }
      }

      if (!found) {
        // Output default 0 for unlabelled scalars
        lines.push(`${name} 0`);
      }
    }

    return lines.join('\n') + '\n';
  }
}

export const metrics = new MetricsRegistry();

/**
 * Starts internal Prometheus scrape HTTP server on METRICS_PORT.
 *
 * @param {number} [port=9090]
 * @returns {Promise<{ server: http.Server, close: () => Promise<void> }>}
 */
export async function startMetricsServer(port = 9090) {
  const server = http.createServer((req, res) => {
    if (req.method === 'GET' && req.url === '/metrics') {
      const body = metrics.toPrometheusText();
      res.writeHead(200, {
        'Content-Type': 'text/plain; version=0.0.4; charset=utf-8',
        'Content-Length': Buffer.byteLength(body),
      });
      res.end(body);
    } else {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end('Not Found');
    }
  });

  await new Promise((resolve, reject) => {
    server.listen(port, '0.0.0.0', () => {
      logger.info(`Prometheus metrics server listening on port ${port}`);
      resolve(undefined);
    });
    server.on('error', reject);
  });

  return {
    server,
    close: () =>
      new Promise((resolve) => {
        server.close(() => resolve());
      }),
  };
}
