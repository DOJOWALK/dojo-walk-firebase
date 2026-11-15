const test = require('node:test');
const assert = require('node:assert/strict');
const { decideCapturedPayment } = require('../lib/payment-decision.js');

const valid = {
  bookingOrderId: 'order_123',
  bookingAmountPaise: 12500,
  bookingCurrency: 'INR',
  paymentOrderId: 'order_123',
  paymentAmountPaise: 12500,
  paymentCurrency: 'INR',
  paymentStatus: 'captured',
  paymentCaptured: true,
  bookingPaymentStatus: 'unpaid',
  bookingStatus: 'walker_held',
  reservationStatus: 'held',
  reservationExpiresAtMillis: 2000,
  nowMillis: 1000,
};

test('captured matching payment confirms only while walker hold is valid', () => {
  assert.equal(decideCapturedPayment(valid), 'confirm');
});

test('captured payment after hold expiry requires manual payment review', () => {
  assert.equal(decideCapturedPayment({ ...valid, reservationExpiresAtMillis: 1000 }), 'payment_review');
  assert.equal(decideCapturedPayment({ ...valid, reservationStatus: 'expired' }), 'payment_review');
  assert.equal(decideCapturedPayment({ ...valid, bookingStatus: 'draft' }), 'payment_review');
});

test('already-paid or confirmed booking routes another capture to duplicate review', () => {
  assert.equal(decideCapturedPayment({ ...valid, bookingPaymentStatus: 'paid' }), 'duplicate_review');
  assert.equal(decideCapturedPayment({ ...valid, bookingStatus: 'confirmed' }), 'duplicate_review');
});

test('mismatched order, amount, currency or capture state is rejected', () => {
  for (const patch of [
    { paymentOrderId: 'order_other' },
    { paymentAmountPaise: 12501 },
    { bookingAmountPaise: 0 },
    { paymentCurrency: 'USD' },
    { paymentStatus: 'authorized' },
    { paymentCaptured: false },
  ]) {
    assert.equal(decideCapturedPayment({ ...valid, ...patch }), 'reject');
  }
});
