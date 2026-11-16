const test = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { Timestamp, getFirestore } = require('firebase-admin/firestore');
const {
  confirmBookingWithoutPayment,
  cancelCustomerBooking,
} = require('../lib/index.js');

const db = getFirestore();
const customerId = 'customer-no-payment-tests';

test.before(() => {
  if (!process.env.FIRESTORE_EMULATOR_HOST) {
    throw new Error('FIRESTORE_EMULATOR_HOST must be set by firebase emulators:exec');
  }
});

function callable(fn, uid, bookingId) {
  return fn.run({
    data: { bookingId },
    auth: uid ? { uid, token: {} } : null,
  });
}

async function seedHeldBooking(overrides = {}) {
  const bookingId = 'nopay' + randomUUID().replaceAll('-', '');
  const walkerId = 'walker-' + bookingId;
  const reservationId = 'reservation-' + bookingId;
  const bookingRef = db.collection('bookings').doc(bookingId);
  const walkerRef = db.collection('walkers').doc(walkerId);
  const reservationRef = walkerRef.collection('reservations').doc(reservationId);
  const expiresAt = Timestamp.fromMillis(Date.now() + 10 * 60_000);

  await walkerRef.set({
    active: true,
    applicationStatus: 'approved',
  });
  await reservationRef.set({ status: 'held', expiresAt });
  await bookingRef.set({
    customerId,
    status: 'walker_held',
    paymentStatus: 'unpaid',
    walkerId,
    reservationId,
    reservationExpiresAt: expiresAt,
    ...overrides,
  });

  return { bookingId, bookingRef, walkerRef, reservationRef };
}

test('confirms an eligible booking and its held reservation without payment', async () => {
  const s = await seedHeldBooking();

  const result = await callable(confirmBookingWithoutPayment, customerId, s.bookingId);

  assert.deepEqual(result, {
    bookingId: s.bookingId,
    status: 'confirmed',
    paymentStatus: 'not_required',
  });
  const booking = (await s.bookingRef.get()).data();
  const reservation = (await s.reservationRef.get()).data();
  assert.equal(booking.status, 'confirmed');
  assert.equal(booking.paymentStatus, 'not_required');
  assert.equal(booking.paymentMethod, 'none');
  assert.equal(reservation.status, 'confirmed');
  assert.ok(booking.confirmedAt instanceof Timestamp);
});

test('repeated confirmation is idempotent', async () => {
  const s = await seedHeldBooking();
  await callable(confirmBookingWithoutPayment, customerId, s.bookingId);
  const result = await callable(confirmBookingWithoutPayment, customerId, s.bookingId);
  assert.equal(result.status, 'confirmed');
  assert.equal(result.paymentStatus, 'not_required');
});

test('confirmation requires authentication and booking ownership', async () => {
  const s = await seedHeldBooking();
  await assert.rejects(
    callable(confirmBookingWithoutPayment, null, s.bookingId),
    (error) => error.code === 'unauthenticated',
  );
  await assert.rejects(
    callable(confirmBookingWithoutPayment, 'another-customer', s.bookingId),
    (error) => error.code === 'not-found',
  );
});

test('confirmation rejects expired booking holds', async () => {
  const s = await seedHeldBooking();
  await s.bookingRef.update({
    reservationExpiresAt: Timestamp.fromMillis(Date.now() - 1),
  });
  await assert.rejects(
    callable(confirmBookingWithoutPayment, customerId, s.bookingId),
    (error) => error.code === 'failed-precondition',
  );
  assert.equal((await s.bookingRef.get()).data().status, 'walker_held');
});

test('confirmation rejects an inactive walker or a reservation that is not held', async () => {
  const inactive = await seedHeldBooking();
  await inactive.walkerRef.update({ active: false });
  await assert.rejects(
    callable(confirmBookingWithoutPayment, customerId, inactive.bookingId),
    (error) => error.code === 'failed-precondition',
  );

  const released = await seedHeldBooking();
  await released.reservationRef.update({ status: 'released' });
  await assert.rejects(
    callable(confirmBookingWithoutPayment, customerId, released.bookingId),
    (error) => error.code === 'failed-precondition',
  );
});

test('confirmation rejects bookings with an existing or in-progress payment order', async () => {
  for (const patch of [
    { razorpayOrderId: 'order-existing' },
    { paymentOrderStatus: 'creating' },
    { paymentId: 'payment-existing' },
  ]) {
    const s = await seedHeldBooking(patch);
    await assert.rejects(
      callable(confirmBookingWithoutPayment, customerId, s.bookingId),
      (error) => error.code === 'failed-precondition',
    );
    assert.equal((await s.bookingRef.get()).data().status, 'walker_held');
  }
});

test('customer can cancel a future confirmed no-payment booking and its reservation', async () => {
  const s = await seedHeldBooking({
    status: 'confirmed',
    paymentStatus: 'not_required',
    scheduledAt: Timestamp.fromMillis(Date.now() + 24 * 60 * 60_000),
  });
  await s.reservationRef.update({ status: 'confirmed' });

  const result = await callable(cancelCustomerBooking, customerId, s.bookingId);

  assert.deepEqual(result, { bookingId: s.bookingId, status: 'cancelled' });
  assert.equal((await s.bookingRef.get()).data().status, 'cancelled');
  assert.equal((await s.reservationRef.get()).data().status, 'cancelled');
});

test('customer can cancel an unpaid draft without a reservation', async () => {
  const bookingId = 'nopaydraft' + randomUUID().replaceAll('-', '');
  const bookingRef = db.collection('bookings').doc(bookingId);
  await bookingRef.set({ customerId, status: 'draft', paymentStatus: 'unpaid' });

  const result = await callable(cancelCustomerBooking, customerId, bookingId);

  assert.equal(result.status, 'cancelled');
  assert.equal((await bookingRef.get()).data().status, 'cancelled');
});

test('cancellation rejects started, past, or payment-order bookings', async () => {
  const started = await seedHeldBooking({
    status: 'confirmed',
    paymentStatus: 'not_required',
    scheduledAt: Timestamp.fromMillis(Date.now() + 60 * 60_000),
    startedAt: Timestamp.now(),
  });
  await assert.rejects(
    callable(cancelCustomerBooking, customerId, started.bookingId),
    (error) => error.code === 'failed-precondition',
  );

  const past = await seedHeldBooking({
    status: 'confirmed',
    paymentStatus: 'not_required',
    scheduledAt: Timestamp.fromMillis(Date.now() - 60_000),
  });
  await assert.rejects(
    callable(cancelCustomerBooking, customerId, past.bookingId),
    (error) => error.code === 'failed-precondition',
  );

  const payment = await seedHeldBooking({
    status: 'confirmed',
    paymentStatus: 'not_required',
    scheduledAt: Timestamp.fromMillis(Date.now() + 60 * 60_000),
    razorpayOrderId: 'order-should-block-cancel',
  });
  await assert.rejects(
    callable(cancelCustomerBooking, customerId, payment.bookingId),
    (error) => error.code === 'failed-precondition',
  );
});

test('cancellation requires the booking owner', async () => {
  const s = await seedHeldBooking({
    status: 'confirmed',
    paymentStatus: 'not_required',
    scheduledAt: Timestamp.fromMillis(Date.now() + 60 * 60_000),
  });
  await assert.rejects(
    callable(cancelCustomerBooking, 'another-customer', s.bookingId),
    (error) => error.code === 'not-found',
  );
  assert.equal((await s.bookingRef.get()).data().status, 'confirmed');
});
