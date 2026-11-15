const test = require('node:test');
const assert = require('node:assert/strict');
const { initializeApp, deleteApp } = require('firebase-admin/app');
const { getFirestore, Timestamp } = require('firebase-admin/firestore');
const { finalizeCapturedRazorpayPayment } = require('../lib/payment-finalizer.js');

const projectId = 'demo-dojo-walk';
const app = initializeApp({ projectId }, 'payment-finalizer-emulator-tests');
const db = getFirestore(app);
const now = Date.now();

test.before(() => {
  if (!process.env.FIRESTORE_EMULATOR_HOST) {
    throw new Error('FIRESTORE_EMULATOR_HOST must be set by firebase emulators:exec');
  }
});

test.after(async () => {
  await deleteApp(app);
});

async function seedBooking(id, overrides = {}) {
  const bookingId = id;
  const walkerId = 'walker-' + id;
  const reservationId = 'reservation-' + id;
  const bookingRef = db.collection('bookings').doc(bookingId);
  const reservationRef = db.collection('walkers').doc(walkerId)
    .collection('reservations').doc(reservationId);
  await bookingRef.set({
    customerId: 'customer-1',
    status: 'walker_held',
    paymentStatus: 'unpaid',
    razorpayOrderId: 'order-' + id,
    razorpayAmountPaise: 12500,
    razorpayCurrency: 'INR',
    walkerId,
    reservationId,
    ...overrides,
  });
  await reservationRef.set({
    status: 'held',
    expiresAt: Timestamp.fromMillis(now + 60_000),
  });
  return { bookingId, reservationRef };
}

function capturedPayment(id, overrides = {}) {
  return {
    id: 'pay-' + id,
    order_id: 'order-' + id,
    amount: 12500,
    currency: 'INR',
    status: 'captured',
    captured: true,
    created_at: Math.floor(now / 1000),
    ...overrides,
  };
}

test('captured payment atomically confirms booking, reservation and payment record', async () => {
  const { bookingId, reservationRef } = await seedBooking('valid');
  const result = await finalizeCapturedRazorpayPayment(db, bookingId, capturedPayment('valid'), 'checkout');
  assert.equal(result.status, 'confirmed');
  const booking = (await db.collection('bookings').doc(bookingId).get()).data();
  const reservation = (await reservationRef.get()).data();
  const payment = (await db.collection('razorpayPayments').doc('pay-valid').get()).data();
  assert.equal(booking.status, 'confirmed');
  assert.equal(booking.paymentStatus, 'paid');
  assert.equal(reservation.status, 'confirmed');
  assert.equal(reservation.paymentId, 'pay-valid');
  assert.equal(payment.status, 'captured');
  assert.equal(payment.bookingId, bookingId);
});

test('capture after reservation expiry records payment review, never confirms the walk', async () => {
  const { bookingId, reservationRef } = await seedBooking('expired');
  await reservationRef.update({ expiresAt: Timestamp.fromMillis(now - 1) });
  const result = await finalizeCapturedRazorpayPayment(db, bookingId, capturedPayment('expired'), 'webhook');
  assert.equal(result.status, 'payment_review');
  const booking = (await db.collection('bookings').doc(bookingId).get()).data();
  const reservation = (await reservationRef.get()).data();
  assert.equal(booking.status, 'payment_review');
  assert.equal(booking.paymentReviewRequired, true);
  assert.equal(reservation.status, 'held');
});

test('repeated finalization of the same payment is idempotent', async () => {
  const { bookingId } = await seedBooking('repeat');
  const payment = capturedPayment('repeat');
  const first = await finalizeCapturedRazorpayPayment(db, bookingId, payment, 'checkout');
  const second = await finalizeCapturedRazorpayPayment(db, bookingId, payment, 'webhook');
  assert.equal(first.status, 'confirmed');
  assert.equal(second.status, 'confirmed');
  const payments = await db.collection('razorpayPayments').where('bookingId', '==', bookingId).get();
  assert.equal(payments.size, 1);
});

test('concurrent duplicate captures produce one payment record and a stable booking state', async () => {
  const { bookingId } = await seedBooking('concurrent');
  const payment = capturedPayment('concurrent');
  const results = await Promise.all([
    finalizeCapturedRazorpayPayment(db, bookingId, payment, 'checkout'),
    finalizeCapturedRazorpayPayment(db, bookingId, payment, 'webhook'),
  ]);
  assert.deepEqual(results.map((result) => result.status).sort(), ['confirmed', 'confirmed']);
  const payments = await db.collection('razorpayPayments').where('bookingId', '==', bookingId).get();
  assert.equal(payments.size, 1);
});

test('payment ID already linked to another booking is rejected', async () => {
  const { bookingId: firstBooking } = await seedBooking('collision-a');
  const { bookingId: secondBooking } = await seedBooking('collision-b');
  const payment = capturedPayment('collision-a');
  await finalizeCapturedRazorpayPayment(db, firstBooking, payment, 'checkout');
  await assert.rejects(
    finalizeCapturedRazorpayPayment(db, secondBooking, payment, 'webhook'),
    /already linked to another booking/,
  );
});
