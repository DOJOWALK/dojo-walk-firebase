const test = require('node:test');
const assert = require('node:assert/strict');
const {
  initializeTestEnvironment,
  assertSucceeds,
  assertFails,
} = require('@firebase/rules-unit-testing');
const { doc, getDoc, setDoc, updateDoc } = require('firebase/firestore');
const fs = require('node:fs');
const path = require('node:path');

let testEnv;

test.before(async () => {
  const [host, portText] = (process.env.FIRESTORE_EMULATOR_HOST || '127.0.0.1:8080').split(':');
  testEnv = await initializeTestEnvironment({
    projectId: 'demo-dojo-walk',
    firestore: {
      host,
      port: Number(portText),
      rules: fs.readFileSync(path.join(__dirname, '../../firestore.rules'), 'utf8'),
    },
  });
  await testEnv.withSecurityRulesDisabled(async (context) => {
    const db = context.firestore();
    await setDoc(doc(db, 'users/customer-1'), { displayName: 'Customer' });
    await setDoc(doc(db, 'users/customer-2'), { displayName: 'Other customer' });
    await setDoc(doc(db, 'walkers/walker-1'), { active: true });
    await setDoc(doc(db, 'bookings/booking-1'), {
      customerId: 'customer-1',
      walkerId: 'walker-1',
      status: 'confirmed',
    });
    await setDoc(doc(db, 'pricingAuditLogs/log-1'), { newAmountPaise: 10000 });
  });
});

test.after(async () => {
  if (testEnv) await testEnv.cleanup();
});

test('customers can read only their own user profile', async () => {
  const customer = testEnv.authenticatedContext('customer-1').firestore();
  const other = testEnv.authenticatedContext('customer-2').firestore();
  await assertSucceeds(getDoc(doc(customer, 'users/customer-1')));
  await assertFails(getDoc(doc(customer, 'users/customer-2')));
  await assertFails(getDoc(doc(other, 'users/customer-1')));
});

test('customers may update profile fields but cannot grant themselves privileges', async () => {
  const customer = testEnv.authenticatedContext('customer-1').firestore();
  await assertSucceeds(updateDoc(doc(customer, 'users/customer-1'), { displayName: 'Updated' }));
  await assertFails(updateDoc(doc(customer, 'users/customer-1'), { admin: true }));
  await assertFails(setDoc(doc(customer, 'users/customer-3'), {
    displayName: 'New customer',
    admin: true,
  }));
});

test('booking reads are limited to the assigned customer, walker, and admin', async () => {
  const customer = testEnv.authenticatedContext('customer-1').firestore();
  const other = testEnv.authenticatedContext('customer-2').firestore();
  const walker = testEnv.authenticatedContext('walker-1').firestore();
  const admin = testEnv.authenticatedContext('admin-1', { admin: true }).firestore();
  await assertSucceeds(getDoc(doc(customer, 'bookings/booking-1')));
  await assertFails(getDoc(doc(other, 'bookings/booking-1')));
  await assertSucceeds(getDoc(doc(walker, 'bookings/booking-1')));
  await assertSucceeds(getDoc(doc(admin, 'bookings/booking-1')));
});

test('booking, walker, reservation, and server audit writes stay server-only', async () => {
  const customer = testEnv.authenticatedContext('customer-1').firestore();
  const walker = testEnv.authenticatedContext('walker-1').firestore();
  const admin = testEnv.authenticatedContext('admin-1', { admin: true }).firestore();
  await assertFails(updateDoc(doc(customer, 'bookings/booking-1'), { status: 'completed' }));
  await assertFails(updateDoc(doc(admin, 'bookings/booking-1'), { status: 'completed' }));
  await assertFails(setDoc(doc(walker, 'walkers/walker-1/reservations/fake'), { status: 'held' }));
  await assertFails(setDoc(doc(walker, 'walkers/walker-1'), { active: false }));
  await assertFails(getDoc(doc(customer, 'pricingAuditLogs/log-1')));
  await assertFails(setDoc(doc(admin, 'pricingAuditLogs/fake'), { newAmountPaise: 1 }));
});
