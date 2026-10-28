import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveRouting } from '../../src/routing/routing-resolver.mjs';

test('resolveRouting(): Mode B resolves directly on dedicated connection without DB queries', async () => {
  let queryCalled = false;
  /** @type {any} */
  const mockClient = {
    async query() {
      queryCalled = true;
      return { rows: [] };
    },
  };

  /** @type {any} */
  const dedicatedConnection = {
    id: 'conn_123',
    environment: 'live',
    application_id: 'app_tenant_alpha',
  };

  const result = await resolveRouting(mockClient, {
    providerConnection: dedicatedConnection,
    routingKeys: { merchantReference: 'ref_1', providerReference: null, virtualAccountId: null },
  });

  assert.equal(result.status, 'resolved');
  assert.equal(result.applicationId, 'app_tenant_alpha');
  assert.equal(result.routingMode, 'MODE_B_DEDICATED_CONNECTION');
  assert.equal(queryCalled, false);
});

test('resolveRouting(): Mode A matches merchant reference', async () => {
  /** @type {any} */
  const mockClient = {
    async query() {
      return {
        rows: [{ id: 'intent_999', application_id: 'app_merchant_beta' }],
      };
    },
  };

  /** @type {any} */
  const sharedConnection = {
    id: 'conn_shared',
    environment: 'live',
    application_id: null,
  };

  const result = await resolveRouting(mockClient, {
    providerConnection: sharedConnection,
    routingKeys: { merchantReference: 'ORD-5544', providerReference: null, virtualAccountId: null },
  });

  assert.equal(result.status, 'resolved');
  assert.equal(result.applicationId, 'app_merchant_beta');
  assert.equal(result.paymentIntentId, 'intent_999');
  assert.equal(result.routingMode, 'MODE_A_MERCHANT_REFERENCE');
});

test('resolveRouting(): Mode A quarantines when ambiguous multiple matches occur', async () => {
  /** @type {any} */
  const mockClient = {
    async query() {
      return {
        rows: [
          { id: 'intent_1', application_id: 'app_1' },
          { id: 'intent_2', application_id: 'app_2' },
        ],
      };
    },
  };

  /** @type {any} */
  const sharedConnection = {
    id: 'conn_shared',
    environment: 'live',
    application_id: null,
  };

  const result = await resolveRouting(mockClient, {
    providerConnection: sharedConnection,
    routingKeys: { merchantReference: 'ORD-COLLISION', providerReference: null, virtualAccountId: null },
  });

  assert.equal(result.status, 'quarantined');
  assert.equal(result.applicationId, null);
  assert.equal(result.routingMode, 'CONFLICT_MULTIPLE_MATCHES');
});

test('resolveRouting(): Mode C matches dynamic alias', async () => {
  let queryCount = 0;
  /** @type {any} */
  const mockClient = {
    /** @param {string} sql */
    async query(sql) {
      queryCount++;
      if (sql.includes('payment_intent_correlations') && !sql.includes('payment_intent_aliases')) {
        return { rows: [] }; // Mode A missed
      }
      return {
        rows: [{ id: 'intent_alias_match', application_id: 'app_gamma' }],
      };
    },
  };

  /** @type {any} */
  const sharedConnection = {
    id: 'conn_shared',
    environment: 'live',
    application_id: null,
  };

  const result = await resolveRouting(mockClient, {
    providerConnection: sharedConnection,
    routingKeys: {
      merchantReference: 'UNMATCHED_REF',
      providerReference: 'flw_ref_dynamic_9988',
      virtualAccountId: null,
    },
  });

  assert.equal(result.status, 'resolved');
  assert.equal(result.applicationId, 'app_gamma');
  assert.equal(result.paymentIntentId, 'intent_alias_match');
  assert.equal(result.routingMode, 'MODE_C_DYNAMIC_ALIAS');
});

test('resolveRouting(): Mode D marks awaiting_route when no candidates match', async () => {
  /** @type {any} */
  const mockClient = {
    async query() {
      return { rows: [] };
    },
  };

  /** @type {any} */
  const sharedConnection = {
    id: 'conn_shared',
    environment: 'live',
    application_id: null,
  };

  const result = await resolveRouting(mockClient, {
    providerConnection: sharedConnection,
    routingKeys: { merchantReference: 'UNKNOWN_ORD', providerReference: null, virtualAccountId: null },
  });

  assert.equal(result.status, 'awaiting_route');
  assert.equal(result.applicationId, null);
  assert.equal(result.paymentIntentId, null);
  assert.equal(result.routingMode, 'UNRESOLVED_NO_MATCH');
});
