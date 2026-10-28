import test from 'node:test';
import assert from 'node:assert/strict';
import { redact, createLogger } from '../../src/observability/logger.mjs';

test('redact() recursively replaces sensitive fields with [REDACTED]', () => {
  const sensitiveObj = {
    tenantId: 'app_123',
    headers: {
      authorization: 'Bearer super_secret_token',
      'verif-hash': 'webhook_secret_hash',
      'x-forwarded-for': '1.2.3.4',
    },
    credentials: {
      apiKey: 'key_live_999',
      password: 'mypassword',
    },
    safeData: {
      status: 'pending',
      amount: 5000,
    },
  };

  const sanitized = redact(sensitiveObj);

  assert.equal(sanitized.tenantId, 'app_123');
  assert.equal(sanitized.safeData.status, 'pending');
  assert.equal(sanitized.safeData.amount, 5000);
  assert.equal(sanitized.headers['x-forwarded-for'], '1.2.3.4');

  // Redacted fields
  assert.equal(sanitized.headers.authorization, '[REDACTED]');
  assert.equal(sanitized.headers['verif-hash'], '[REDACTED]');
  assert.equal(sanitized.credentials.apiKey, '[REDACTED]');
  assert.equal(sanitized.credentials.password, '[REDACTED]');
});

test('redact() handles circular object references safely', () => {
  /** @type {any} */
  const circular = { name: 'root' };
  circular.self = circular;

  const result = redact(circular);
  assert.equal(result.name, 'root');
  assert.equal(result.self, '[CIRCULAR]');
});

test('redact() summarizes Buffer contents', () => {
  const buf = Buffer.from('hello world');
  const result = redact({ payload: buf });
  assert.equal(result.payload, '[BUFFER len=11]');
});

test('createLogger() formats structured records with context and error', () => {
  const log = createLogger({ service: 'cwids-test' });
  const err = new Error('Database connection failed');
  // @ts-ignore - assign error code
  err.code = 'ECONNREFUSED';

  const record = log.warn('Warning event', { attempt: 3, token: 'secret' }, err);

  assert.equal(record.level, 'warn');
  assert.equal(record.message, 'Warning event');
  assert.equal(record.context.service, 'cwids-test');
  assert.equal(record.context.attempt, 3);
  assert.equal(record.context.token, '[REDACTED]');
  assert.equal(record.error.name, 'Error');
  assert.equal(record.error.message, 'Database connection failed');
  assert.equal(record.error.code, 'ECONNREFUSED');
  assert.ok(record.timestamp);
});
