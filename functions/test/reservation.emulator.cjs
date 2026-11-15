const test = require('node:test');
const assert = require('node:assert/strict');
const { initializeApp, deleteApp } = require('firebase-admin/app');
const { getFirestore, Timestamp } = require('firebase-admin/firestore');
const { reserveWalkerTransaction } = require('../lib/reservation.js');

const projectId = 'demo-dojo-walk';
const app = initializeApp({ projectId }, 'walker-reservation-emulator-tests');
const db = getFirestore(app);
let sequence = 0;

test.before(() => {
  if (!process.env.FIRESTORE_EMULATOR_HOST) {
    throw new Error('FIRESTORE_EMULATOR_HOST must be set by firebase emulators:exec');
  }
});

test.after(async () => {
  await deleteApp(app);
});

async function seedScenario({ startOffsetMinutes = 120, existingReservation = null, coverageEnabled = true } = {}) {
  const id = 'reservation-test-' + (++sequence);
  const walkerId = 'walker-' + id;
  const customerId = 'customer-' + id;
  const bookingId = 'booking-' + id;
  const now = Date.now();
  const startAt = Timestamp.fromMillis(now + startOffsetMinutes * 60000);
  const endAt = Timestamp.fromMillis(startAt.toMillis() + 30 * 60000);
  const walkerRef = db.collection('walkers').doc(walkerId);
  const coverageRef = db.doc('serviceAreas/ghaziabad/pincodes/201009');
  const bookingRef = db.collection('bookings').doc(bookingId);
  const reservationRef = walkerRef.collection('reservations').doc('new-' + id);

  await walkerRef.set({
    active: true,
    serviceablePincodes: ['201009'],
    travelBufferMinutes: 15,
    reservationVersion: 0,
  });
  await coverageRef.set({
    enabled: coverageEnabled,
    city: 'Ghaziabad',
    walkerIds: [walkerId],
  });
  await walkerRef.collection('availabilityWindows').doc('window').set({
    status: 'available',
    startAt: Timestamp.fromMillis(startAt.toMillis() - 60 * 60000),
    endAt: Timestamp.fromMillis(endAt.toMillis() + 60 * 60000),
  });
  await bookingRef.set({
    customerId,
    status: 'draft',
    city: 'Ghaziabad',
    pincode: '201009',
    scheduledAt: startAt,
    endsAt: endAt,
    eligibleWalkerIds: [walkerId],
  });
  if (existingReservation) {
    await walkerRef.collection('reservations').doc('existing-' + id).set({
      bookingId: 'prior-' + id,
      customerId: 'prior-customer',
      startAt: Timestamp.fromMillis(startAt.toMillis() + existingReservation.startOffsetMinutes * 60000),
      endAt: Timestamp.fromMillis(startAt.toMillis() + existingReservation.endOffsetMinutes * 60000),
      bufferBeforeMinutes: existingReservation.bufferBeforeMinutes ?? 15,
      bufferAfterMinutes: existingReservation.bufferAfterMinutes ?? 15,
      status: existingReservation.status,
      expiresAt: Timestamp.fromMillis(existingReservation.expiresAtMillis ?? now + 60000),
    });
  }
  return {
    id, walkerId, customerId, bookingId, walkerRef, coverageRef, bookingRef, reservationRef,
    city: 'Ghaziabad', pincode: '201009', holdExpiresAt: Timestamp.fromMillis(now + 10 * 60000),
    startAt, endAt,
  };
}

function reserve(s, bookingId = s.bookingId, customerId = s.customerId, reservationRef = s.reservationRef) {
  return reserveWalkerTransaction(db, {
    bookingRef: db.collection('bookings').doc(bookingId),
    walkerRef: s.walkerRef,
    coverageRef: s.coverageRef,
    reservationRef,
    bookingId,
    customerId,
    walkerId: s.walkerId,
    expectedCity: s.city,
    expectedPincode: s.pincode,
    holdExpiresAt: s.holdExpiresAt,
  });
}

test('concurrent overlapping booking attempts create exactly one active walker hold', async () => {
  const s = await seedScenario();
  const secondBookingId = 'booking-second-' + s.id;
  const secondReservationRef = s.walkerRef.collection('reservations').doc('second-' + s.id);
  await db.collection('bookings').doc(secondBookingId).set({
    customerId: 'customer-second-' + s.id,
    status: 'draft',
    city: s.city,
    pincode: s.pincode,
    scheduledAt: s.startAt,
    endsAt: s.endAt,
    eligibleWalkerIds: [s.walkerId],
  });

  const results = await Promise.all([
    reserve(s),
    reserve(s, secondBookingId, 'customer-second-' + s.id, secondReservationRef),
  ]);
  assert.deepEqual(results.sort(), [false, true]);
  const holds = await s.walkerRef.collection('reservations').where('status', '==', 'held').get();
  assert.equal(holds.size, 1);
  const bookings = await db.collection('bookings').where('walkerId', '==', s.walkerId).get();
  assert.equal(bookings.size, 1);
});

test('an expired prior hold does not block a new reservation', async () => {
  const s = await seedScenario({
    existingReservation: {
      startOffsetMinutes: 0,
      endOffsetMinutes: 30,
      status: 'held',
      expiresAtMillis: Date.now() - 1000,
    },
  });
  assert.equal(await reserve(s), true);
  const booking = (await s.bookingRef.get()).data();
  assert.equal(booking.status, 'walker_held');
});

test('a confirmed reservation with overlapping travel buffer blocks the new hold', async () => {
  const s = await seedScenario({
    startOffsetMinutes: 60,
    existingReservation: {
      startOffsetMinutes: -45,
      endOffsetMinutes: -15,
      status: 'confirmed',
      bufferBeforeMinutes: 15,
      bufferAfterMinutes: 15,
    },
  });
  assert.equal(await reserve(s), false);
  const booking = (await s.bookingRef.get()).data();
  assert.equal(booking.status, 'draft');
});
