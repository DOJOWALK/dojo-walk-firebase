const test = require('node:test');
const assert = require('node:assert/strict');
const { decideCapturedPayment } = require('../lib/payment-decision.js');

const valid = {
  bookingOrderId: 'order_123', bookingAmountPaise: 12500, bookingCurrency: 'INR',
  paymentOrderId: 'order_123', paymentAmountPaise: 12500, paymentCurrency: 'INR',
  paymentStatus: 'captured', paymentCaptured: true, bookingPaymentStatus: 'unpaid',
  bookingStatus: 'walker_held', reservationStatus: 'held',
  reservationExpiresAtMillis: 2000, nowMillis: 1000,
};

test('matching captured payment confirms only with a live walker hold', () => {
  assert.equal(decideCapturedPayment(valid), 'confirm');
});
test('expired, missing or released hold requires payment review', () => {
  assert.equal(decideCapturedPayment({ ...valid, reservationExpiresAtMillis: 1000 }), 'payment_review');
  assert.equal(decideCapturedPayment({ ...valid, reservationStatus: 'expired' }), 'payment_review');
  assert.equal(decideCapturedPayment({ ...valid, bookingStatus: 'draft' }), 'payment_review');
});
test('additional capture on a paid or confirmed booking is flagged for duplicate review', () => {
  assert.equal(decideCapturedPayment({ ...valid, bookingPaymentStatus: 'paid' }), 'duplicate_review');
  assert.equal(decideCapturedPayment({ ...valid, bookingStatus: 'confirmed' }), 'duplicate_review');
});
test('order, amount, currency and capture mismatches are rejected', () => {
  for (const patch of [
    { paymentOrderId: 'order_other' }, { paymentAmountPaise: 12501 },
    { bookingAmountPaise: 0 }, { paymentCurrency: 'USD' },
    { paymentStatus: 'authorized' }, { paymentCaptured: false },
  ]) assert.equal(decideCapturedPayment({ ...valid, ...patch }), 'reject');
});

