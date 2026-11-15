const test = require('node:test');
const assert = require('node:assert/strict');
const { initializeApp, deleteApp } = require('firebase-admin/app');
const { getFirestore, Timestamp } = require('firebase-admin/firestore');
const { setCustomerBookingSeriesStatus } = require('../lib/series-lifecycle.js');

const projectId = 'demo-dojo-walk';
const app = initializeApp({ projectId }, 'series-lifecycle-emulator-tests');
const db = getFirestore(app);

test.before(() => {
  if (!process.env.FIRESTORE_EMULATOR_HOST) {
    throw new Error('FIRESTORE_EMULATOR_HOST must be set by firebase emulators:exec');
  }
});

test.after(async () => {
  await deleteApp(app);
});

test('pausing and resuming a series never mutates paid or unpaid occurrence records', async () => {
  const seriesId = 'a'.repeat(40);
  const seriesRef = db.collection('bookingSeries').doc(seriesId);
  const paidRef = db.collection('bookings').doc('paid-occurrence-lifecycle');
  const draftRef = db.collection('bookings').doc('draft-occurrence-lifecycle');
  await seriesRef.set({ customerId: 'owner-1', status: 'draft', updatedAt: Timestamp.now() });
  await paidRef.set({ customerId: 'owner-1', seriesId, status: 'confirmed', paymentStatus: 'paid' });
  await draftRef.set({ customerId: 'owner-1', seriesId, status: 'draft', paymentStatus: 'unpaid' });

  assert.equal(await setCustomerBookingSeriesStatus(db, {
    seriesRef, customerId: 'owner-1', action: 'pause',
  }), true);
  assert.equal((await seriesRef.get()).data().status, 'paused');
  assert.equal((await paidRef.get()).data().status, 'confirmed');
  assert.equal((await paidRef.get()).data().paymentStatus, 'paid');
  assert.equal((await draftRef.get()).data().status, 'draft');

  assert.equal(await setCustomerBookingSeriesStatus(db, {
    seriesRef, customerId: 'owner-1', action: 'resume',
  }), true);
  assert.equal((await seriesRef.get()).data().status, 'active');
  assert.equal((await paidRef.get()).data().paymentStatus, 'paid');
});

test('pause and resume are idempotent in their target state', async () => {
  const seriesRef = db.collection('bookingSeries').doc('b'.repeat(40));
  await seriesRef.set({ customerId: 'owner-2', status: 'active' });
  assert.equal(await setCustomerBookingSeriesStatus(db, {
    seriesRef, customerId: 'owner-2', action: 'pause',
  }), true);
  assert.equal(await setCustomerBookingSeriesStatus(db, {
    seriesRef, customerId: 'owner-2', action: 'pause',
  }), false);
  assert.equal(await setCustomerBookingSeriesStatus(db, {
    seriesRef, customerId: 'owner-2', action: 'resume',
  }), true);
  assert.equal(await setCustomerBookingSeriesStatus(db, {
    seriesRef, customerId: 'owner-2', action: 'resume',
  }), false);
});

test('a different customer cannot pause another owner schedule', async () => {
  const seriesRef = db.collection('bookingSeries').doc('c'.repeat(40));
  await seriesRef.set({ customerId: 'owner-3', status: 'active' });
  await assert.rejects(
    setCustomerBookingSeriesStatus(db, {
      seriesRef, customerId: 'intruder', action: 'pause',
    }),
    (error) => error.code === 'not-found',
  );
  assert.equal((await seriesRef.get()).data().status, 'active');
});

test('completed schedules cannot be resumed', async () => {
  const seriesRef = db.collection('bookingSeries').doc('d'.repeat(40));
  await seriesRef.set({ customerId: 'owner-4', status: 'completed' });
  await assert.rejects(
    setCustomerBookingSeriesStatus(db, {
      seriesRef, customerId: 'owner-4', action: 'resume',
    }),
    (error) => error.code === 'failed-precondition',
  );
  assert.equal((await seriesRef.get()).data().status, 'completed');
});
