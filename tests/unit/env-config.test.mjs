import test from 'node:test';
import assert from 'node:assert/strict';
import { loadEnv } from '../../src/config/env.mjs';

const VALID_KEK_BASE64 = Buffer.alloc(32, 0x42).toString('base64');

test('loadEnv() succeeds with minimal valid configuration and default values', () => {
  const env = loadEnv({
    DATABASE_URL: 'postgresql://cwids:secret@localhost:5432/cwids_dev',
    CWIDS_KEK_BASE64: VALID_KEK_BASE64,
    ADMIN_API_TOKEN: 'secure_admin_token_minimum_16_chars',
  });

  assert.equal(env.NODE_ENV, 'development');
  assert.equal(env.PORT, 3000);
  assert.equal(env.ADMIN_PORT, 3001);
  assert.equal(env.METRICS_PORT, 9090);
  assert.equal(env.DATABASE_URL, 'postgresql://cwids:secret@localhost:5432/cwids_dev');
  assert.equal(env.CWIDS_KEK_BASE64, VALID_KEK_BASE64);
  assert.equal(env.MASTER_KEK.length, 32);
  assert.equal(env.ADMIN_API_TOKEN, 'secure_admin_token_minimum_16_chars');
  assert.equal(env.RETENTION_RAW_PAYLOAD_DAYS, 30);
  assert.equal(env.RETENTION_NORMALIZED_METADATA_DAYS, 90);
  assert.equal(env.RETENTION_AUDIT_SECURITY_DAYS, 2555);
  assert.equal(env.RETENTION_AUDIT_OPERATIONAL_DAYS, 365);
  assert.equal(env.RECONCILIATION_ENABLED, false);
});

test('loadEnv() fails when DATABASE_URL is missing', () => {
  assert.throws(
    () => {
      loadEnv({
        CWIDS_KEK_BASE64: VALID_KEK_BASE64,
        ADMIN_API_TOKEN: 'secure_admin_token_minimum_16_chars',
      });
    },
    /DATABASE_URL is required/,
  );
});

test('loadEnv() fails when CWIDS_KEK_BASE64 is missing or not 32 bytes', () => {
  // Missing
  assert.throws(
    () => {
      loadEnv({
        DATABASE_URL: 'postgresql://localhost:5432/cwids',
        ADMIN_API_TOKEN: 'secure_admin_token_minimum_16_chars',
      });
    },
    /CWIDS_KEK_BASE64 is required/,
  );

  // 16 bytes instead of 32
  const shortKek = Buffer.alloc(16).toString('base64');
  assert.throws(
    () => {
      loadEnv({
        DATABASE_URL: 'postgresql://localhost:5432/cwids',
        CWIDS_KEK_BASE64: shortKek,
        ADMIN_API_TOKEN: 'secure_admin_token_minimum_16_chars',
      });
    },
    /CWIDS_KEK_BASE64 must decode to exactly 32 bytes/,
  );
});

test('loadEnv() fails when ADMIN_API_TOKEN is shorter than 16 characters', () => {
  assert.throws(
    () => {
      loadEnv({
        DATABASE_URL: 'postgresql://localhost:5432/cwids',
        CWIDS_KEK_BASE64: VALID_KEK_BASE64,
        ADMIN_API_TOKEN: 'too_short',
      });
    },
    /ADMIN_API_TOKEN is required and must be at least 16 characters/,
  );
});

test('loadEnv() validates reconciliation configuration consistency', () => {
  assert.throws(
    () => {
      loadEnv({
        DATABASE_URL: 'postgresql://localhost:5432/cwids',
        CWIDS_KEK_BASE64: VALID_KEK_BASE64,
        ADMIN_API_TOKEN: 'secure_admin_token_minimum_16_chars',
        RECONCILIATION_ENABLED: 'true',
      });
    },
    /RECONCILIATION_ENABLED is true, but neither FLUTTERWAVE_RECONCILIATION_SECRET_KEY nor PAYSTACK_RECONCILIATION_SECRET_KEY is configured/,
  );

  const env = loadEnv({
    DATABASE_URL: 'postgresql://localhost:5432/cwids',
    CWIDS_KEK_BASE64: VALID_KEK_BASE64,
    ADMIN_API_TOKEN: 'secure_admin_token_minimum_16_chars',
    RECONCILIATION_ENABLED: 'true',
    FLUTTERWAVE_RECONCILIATION_SECRET_KEY: 'flw_sec_key_123',
  });
  assert.equal(env.RECONCILIATION_ENABLED, true);
  assert.equal(env.FLUTTERWAVE_RECONCILIATION_SECRET_KEY, 'flw_sec_key_123');
});
