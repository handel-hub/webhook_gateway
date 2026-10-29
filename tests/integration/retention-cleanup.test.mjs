import test from 'node:test';
import assert from 'node:assert/strict';
import { RetentionWorker } from '../../src/maintenance/retention-worker.mjs';

function createMockRetentionPool() {
  /** @type {Map<string, any>} */
  const events = new Map();
  /** @type {Map<string, any>} */
  const audits = new Map();
  /** @type {any[]} */
  const systemAuditLogs = [];

  const client = {
    /**
     * @param {string} sql
     * @param {any[]} [params]
     */
    async query(sql, params = []) {
      const s = sql.trim().toUpperCase();

      if (s.startsWith('BEGIN') || s.startsWith('COMMIT') || s.startsWith('ROLLBACK')) {
        return { rows: [] };
      }

      if (s.includes('SET_CONFIG')) {
        return { rows: [] };
      }

      // 1. Prune encrypted payloads
      // CTE: SELECT id FROM cwids.webhook_events WHERE received_at < $1 AND encrypted_payload IS NOT NULL AND legal_hold = FALSE
      if (s.includes('ENCRYPTED_PAYLOAD = NULL') && s.includes('PAYLOAD_DELETED_AT = CURRENT_TIMESTAMP')) {
        const cutoffDate = new Date(params[0]);
        let count = 0;
        for (const ev of events.values()) {
          if (
            new Date(ev.received_at) < cutoffDate &&
            ev.encrypted_payload !== null &&
            ev.legal_hold === false
          ) {
            ev.encrypted_payload = null;
            ev.payload_nonce = null;
            ev.payload_tag = null;
            ev.wrapped_dek = null;
            ev.payload_deleted_at = new Date();
            count++;
          }
        }
        return { rowCount: count };
      }

      // 2. Purge expired terminal metadata
      if (s.includes('DELETE FROM CWIDS.WEBHOOK_EVENTS TARGET')) {
        const cutoffDate = new Date(params[0]);
        let count = 0;
        for (const [id, ev] of events.entries()) {
          if (new Date(ev.received_at) < cutoffDate && ev.legal_hold === false) {
            events.delete(id);
            count++;
          }
        }
        return { rowCount: count };
      }

      // 3. Purge classified audits
      if (s.includes('DELETE FROM CWIDS.ADMINISTRATIVE_AUDIT_EVENTS TARGET')) {
        const opCutoff = new Date(params[0]);
        const secCutoff = new Date(params[1]);
        let count = 0;
        for (const [id, audit] of audits.entries()) {
          if (audit.legal_hold === false) {
            const createdAt = new Date(audit.created_at);
            if (audit.audit_class === 'operational' && createdAt < opCutoff) {
              audits.delete(id);
              count++;
            } else if (['security', 'compliance'].includes(audit.audit_class) && createdAt < secCutoff) {
              audits.delete(id);
              count++;
            }
          }
        }
        return { rowCount: count };
      }

      // 4. Audit logging
      if (s.includes('INSERT INTO CWIDS.ADMINISTRATIVE_AUDIT_EVENTS')) {
        systemAuditLogs.push({ action: 'retention.sweep_completed' });
        return { rows: [{ id: 'audit_sweep_1' }] };
      }

      if (s.includes('INSERT INTO CWIDS.AUDIT_OUTBOX')) {
        return { rows: [{ id: 1 }] };
      }

      // 5. Unrouted alerts check
      if (s.includes("ROUTING_STATUS IN ('AWAITING_ROUTE', 'QUARANTINED')")) {
        return { rows: [] };
      }

      throw new Error(`Unhandled SQL: ${sql}`);
    },
    release() {},
  };

  return {
    events,
    audits,
    systemAuditLogs,
    async connect() {
      return client;
    },
  };
}

test('RetentionWorker: prunes 30-day raw encrypted payloads while preserving metadata', async () => {
  const mockPool = createMockRetentionPool();

  const now = Date.now();
  const thirtyFiveDaysAgo = new Date(now - 35 * 24 * 3600 * 1000);
  const tenDaysAgo = new Date(now - 10 * 24 * 3600 * 1000);

  // Expired payload (should be pruned)
  mockPool.events.set('evt_old_1', {
    id: 'evt_old_1',
    received_at: thirtyFiveDaysAgo,
    encrypted_payload: Buffer.from('encrypted_bytes'),
    payload_nonce: Buffer.alloc(12),
    payload_tag: Buffer.alloc(16),
    wrapped_dek: Buffer.alloc(48),
    payload_deleted_at: null,
    legal_hold: false,
    dedupe_key: 'v1:pstk:tx_old',
    event_type: 'charge.success',
  });

  // Recent payload (should NOT be pruned)
  mockPool.events.set('evt_recent_1', {
    id: 'evt_recent_1',
    received_at: tenDaysAgo,
    encrypted_payload: Buffer.from('recent_bytes'),
    payload_nonce: Buffer.alloc(12),
    payload_tag: Buffer.alloc(16),
    wrapped_dek: Buffer.alloc(48),
    payload_deleted_at: null,
    legal_hold: false,
    dedupe_key: 'v1:pstk:tx_recent',
    event_type: 'charge.success',
  });

  // Execute retention sweep
  const result = await RetentionWorker.runRetentionSweep(/** @type {any} */ (mockPool), {
    rawPayloadRetentionDays: 30,
    normalizedMetadataRetentionDays: 90,
    operationalAuditRetentionDays: 365,
    securityAuditRetentionDays: 2555,
  });

  assert.equal(result.payloadsPruned, 1);

  // Old event payload is nullified, metadata preserved
  const oldEv = mockPool.events.get('evt_old_1');
  assert.equal(oldEv.encrypted_payload, null);
  assert.equal(oldEv.wrapped_dek, null);
  assert.notEqual(oldEv.payload_deleted_at, null);
  assert.equal(oldEv.dedupe_key, 'v1:pstk:tx_old'); // Metadata intact!

  // Recent event payload is untouched
  const recentEv = mockPool.events.get('evt_recent_1');
  assert.notEqual(recentEv.encrypted_payload, null);
  assert.equal(recentEv.payload_deleted_at, null);

  // Auditable execution summary was recorded
  assert.equal(mockPool.systemAuditLogs.length, 1);
});

test('RetentionWorker: legal_hold = TRUE strictly bypasses payload pruning and metadata purging', async () => {
  const mockPool = createMockRetentionPool();

  const now = Date.now();
  const oneHundredDaysAgo = new Date(now - 100 * 24 * 3600 * 1000);

  // 100-day-old event under legal hold
  mockPool.events.set('evt_legal_hold_1', {
    id: 'evt_legal_hold_1',
    received_at: oneHundredDaysAgo,
    encrypted_payload: Buffer.from('disputed_evidence'),
    payload_nonce: Buffer.alloc(12),
    payload_tag: Buffer.alloc(16),
    wrapped_dek: Buffer.alloc(48),
    payload_deleted_at: null,
    legal_hold: true, // EXPLICIT LEGAL HOLD!
    dedupe_key: 'v1:flw:dispute',
  });

  const result = await RetentionWorker.runRetentionSweep(/** @type {any} */ (mockPool), {
    rawPayloadRetentionDays: 30,
    normalizedMetadataRetentionDays: 90,
  });

  assert.equal(result.payloadsPruned, 0);
  assert.equal(result.metadataPurged, 0);

  const ev = mockPool.events.get('evt_legal_hold_1');
  assert.ok(ev);
  assert.notEqual(ev.encrypted_payload, null); // Payload intact!
  assert.equal(ev.payload_deleted_at, null);
});

test('RetentionWorker: purges classified audits according to purpose (365d operational vs 7y security)', async () => {
  const mockPool = createMockRetentionPool();

  const now = Date.now();
  const fourHundredDaysAgo = new Date(now - 400 * 24 * 3600 * 1000); // > 365d, < 2555d

  // Operational audit > 365 days -> Purged
  mockPool.audits.set('audit_op_1', {
    id: 'audit_op_1',
    created_at: fourHundredDaysAgo,
    audit_class: 'operational',
    legal_hold: false,
  });

  // Security audit > 365 days but < 7 years -> Retained!
  mockPool.audits.set('audit_sec_1', {
    id: 'audit_sec_1',
    created_at: fourHundredDaysAgo,
    audit_class: 'security',
    legal_hold: false,
  });

  const result = await RetentionWorker.runRetentionSweep(/** @type {any} */ (mockPool), {
    operationalAuditRetentionDays: 365,
    securityAuditRetentionDays: 2555,
  });

  assert.equal(result.auditsPurged, 1);
  assert.equal(mockPool.audits.has('audit_op_1'), false); // Pruned
  assert.equal(mockPool.audits.has('audit_sec_1'), true); // Retained!
});
