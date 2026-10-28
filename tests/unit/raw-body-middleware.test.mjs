import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import crypto from 'node:crypto';
import { rawBodyMiddleware } from '../../src/ingress/raw-body-middleware.mjs';
import { LIMITS } from '../../src/config/limits.mjs';

test('rawBodyMiddleware preserves exact Buffer bytes and computes SHA-256', (t, done) => {
  const req = new EventEmitter();
  // @ts-ignore
  req.destroy = () => {};

  /** @type {any} */
  const res = {
    statusCode: 200,
    /** @param {number} code */
    status(code) {
      this.statusCode = code;
      return this;
    },
    json() {
      return this;
    },
  };

  const payload = Buffer.from('{"hello":"world","amount":100}');
  const expectedHash = crypto.createHash('sha256').update(payload).digest('hex');

  // @ts-ignore
  rawBodyMiddleware(req, res, () => {
    // @ts-ignore
    assert.ok(Buffer.isBuffer(req.rawBody));
    // @ts-ignore
    assert.deepEqual(req.rawBody, payload);
    // @ts-ignore
    assert.equal(req.payloadSha256, expectedHash);
    done();
  });

  req.emit('data', payload.subarray(0, 10));
  req.emit('data', payload.subarray(10));
  req.emit('end');
});

test('rawBodyMiddleware returns HTTP 413 when body exceeds 1MB limit', (t, done) => {
  const req = new EventEmitter();
  let destroyed = false;
  // @ts-ignore
  req.destroy = () => {
    destroyed = true;
  };

  /** @type {any} */
  const res = {
    statusCode: 200,
    body: null,
    /** @param {number} code */
    status(code) {
      this.statusCode = code;
      return this;
    },
    /** @param {any} data */
    json(data) {
      this.body = data;
      assert.equal(this.statusCode, 413);
      assert.equal(destroyed, true);
      done();
    },
  };

  // @ts-ignore
  rawBodyMiddleware(req, res, () => {
    assert.fail('Should not call next() when payload exceeds limit');
  });

  const oversizedChunk = Buffer.alloc(LIMITS.MAX_RAW_BODY_BYTES + 10);
  req.emit('data', oversizedChunk);
});
