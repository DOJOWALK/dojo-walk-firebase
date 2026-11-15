const test = require('node:test');
const assert = require('node:assert/strict');
const { hmacHex, safeHexEqual } = require('../lib/security.js');

test('checkout signature uses the order_id|payment_id HMAC message', () => {
  const signature = hmacHex('test-secret', 'order_123|pay_456');
  assert.equal(signature, '5e50a0b7b7f6a2d6f9b4d0c40c1e52f9a5d8ec2d49e2c1a4e8ec8b4a88d0a4bb');
  assert.equal(safeHexEqual(signature, hmacHex('test-secret', 'order_123|pay_456')), true);
  assert.equal(safeHexEqual(signature, hmacHex('test-secret', 'order_123|pay_457')), false);
});

test('webhook signature is tied to the exact raw request body', () => {
  const rawBody = '{"event":"payment.captured","payload":{"payment":{"entity":{"id":"pay_456"}}}}';
  const signature = hmacHex('webhook-secret', rawBody);
  assert.equal(safeHexEqual(hmacHex('webhook-secret', rawBody), signature), true);
  assert.equal(safeHexEqual(hmacHex('webhook-secret', rawBody + ' '), signature), false);
});

test('signature comparison rejects malformed, short, and non-hex inputs', () => {
  const valid = hmacHex('secret', 'message');
  assert.equal(safeHexEqual(valid, ''), false);
  assert.equal(safeHexEqual(valid, 'abc'), false);
  assert.equal(safeHexEqual(valid, 'z'.repeat(64)), false);
  assert.equal(safeHexEqual('not-a-digest', valid), false);
});
