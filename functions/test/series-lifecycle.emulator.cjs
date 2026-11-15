const test = require('node:test');
const assert = require('node:assert/strict');
const { initializeTestEnvironment, assertSucceeds } = require('@firebase/rules-unit-testing');
const { doc, getDoc, setDoc } = require('firebase/firestore');
const { setCustomerBookingSeriesStatus } = require('../lib/series-lifecycle');
const { getFirestore, Timestamp } = require('firebase-admin/firestore');

const projectId = 'demo-dojo-walk-series-lifecycle';
let env;
let adminDb;

test.before(async () => {
  env = await initializeTestEnvironment({
    projectId,
    firestore: { rules: require('node:fs').readFileSync('../firestore.rules', 'utf8') },
  });
  // Admin SDK emulator client shares the emulator endpoint used by rules-unit-testing.
  process.env.FIRESTORE_EMULATOR_HOST = process.env.FIRESTORE_EMULATOR_HOST || '127.0.0.1:8080';
  process.env.GCLOUD_PROJECT = projectId;
  const { initializeApp, getApps } = require('firebase-admin/app');
  const app = getApps().find((item) => item.name === 'series-lifecycle-test')
    || initializeApp({ projectId }, 'series-lifecycle-test');
  adminDb = getFirestore(app);
});

test.after(async () => {
  await env?.cleanup();
});

test('owner can pause and resume a series without changing individual paid or unpaid occurrence records', async () => {
  const seriesId = 'a'.repeat(40);
  const seriesRef = adminDb.collection('bookingSeries').doc(seriesId);
  const paidRef = adminDb.collection('bookings').doc('paid-occurrence');
  const draftRef = adminDb.collection('bookings').doc('draft-occurrence');
  await seriesRef.set({ customerId: 'owner-1', status: 'draft', updatedAt: Timestamp.now() });
  await paidRef.set({ customerId: 'owner-1', seriesId, status: 'confirmed', paymentStatus: 'paid' });
  await draftRef.set({ customerId: 'owner-1', seriesId, status: 'draft', paymentStatus: 'unpaid' });

  assert.equal(await setCustomerBookingSeriesStatus(adminDb, {
    seriesRef, customerId: 'owner-1', action: 'pause',
  }), true);
  assert.equal((await seriesRef.get()).data().status, 'paused');
  assert.equal((await paidRef.get()).data().status, 'confirmed');
  assert.equal((await paidRef.get()).data().paymentStatus, 'paid');
  assert.equal((await draftRef.get()).data().status, 'draft');

  assert.equal(await setCustomerBookingSeriesStatus(adminDb, {
    seriesRef, customerId: 'owner-1', action: 'resume',
  }), true);
  assert.equal((await seriesRef.get()).data().status, 'active');
  assert.equal((await paidRef.get()).data().paymentStatus, 'paid');
});

test('pause and resume are idempotent in their target state', async () => {
  const seriesRef = adminDb.collection('bookingSeries').doc('b'.repeat(40));
  await seriesRef.set({ customerId: 'owner-2', status: 'active' });
  assert.equal(await setCustomerBookingSeriesStatus(adminDb, {
    seriesRef, customerId: 'owner-2', action: 'pause',
  }), true);
  assert.equal(await setCustomerBookingSeriesStatus(adminDb, {
    seriesRef, customerId: 'owner-2', action: 'pause',
  }), false);
  assert.equal(await setCustomerBookingSeriesStatus(adminDb, {
    seriesRef, customerId: 'owner-2', action: 'resume',
  }), true);
  assert.equal(await setCustomerBookingSeriesStatus(adminDb, {
    seriesRef, customerId: 'owner-2', action: 'resume',
  }), false);
});

test('a different customer cannot pause or resume another owner schedule', async () => {
  const seriesRef = adminDb.collection('bookingSeries').doc('c'.repeat(40));
  await seriesRef.set({ customerId: 'owner-3', status: 'active' });
  await assert.rejects(setCustomerBookingSeriesStatus(adminDb, {
    seriesRef, customerId: 'intruder', action: 'pause',
  }), /not-found/);
  assert.equal((await seriesRef.get()).data().status, 'active');
});

test('completed or cancelled schedules cannot be resumed', async () => {
  const seriesRef = adminDb.collection('bookingSeries').doc('d'.repeat(40));
  await seriesRef.set({ customerId: 'owner-4', status: 'completed' });
  await assert.rejects(setCustomerBookingSeriesStatus(adminDb, {
    seriesRef, customerId: 'owner-4', action: 'resume',
  }), /Only a paused recurring schedule can be resumed/);
  assert.equal((await seriesRef.get()).data().status, 'completed');
});
