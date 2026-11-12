import { initializeApp } from 'firebase-admin/app';
import { getFirestore, Timestamp } from 'firebase-admin/firestore';
import { onCall, HttpsError } from 'firebase-functions/v2/https';

initializeApp();
const db = getFirestore();
const allowedDurations = new Set([30, 45, 60]);
const launchCities = new Set(['Noida', 'Greater Noida', 'Ghaziabad']);

export const createBookingDraft = onCall(async (request) => {
  if (!request.auth) {
    throw new HttpsError('unauthenticated', 'Sign in to create a booking.');
  }

  const data = request.data ?? {};
  const { durationMinutes, scheduledAt, address, petName, city } = data;

  if (!Number.isInteger(durationMinutes) || !allowedDurations.has(durationMinutes)) {
    throw new HttpsError('invalid-argument', 'Duration must be 30, 45, or 60 minutes.');
  }
  if (typeof city !== 'string' || !launchCities.has(city)) {
    throw new HttpsError('failed-precondition', 'This city is not in the initial launch area.');
  }
  if (typeof address !== 'string' || !address.trim() || address.trim().length > 500) {
    throw new HttpsError('invalid-argument', 'Provide a walk address (up to 500 characters).');
  }
  if (typeof petName !== 'string' || !petName.trim() || petName.trim().length > 80) {
    throw new HttpsError('invalid-argument', 'Provide a pet name (up to 80 characters).');
  }
  if (typeof scheduledAt !== 'string') {
    throw new HttpsError('invalid-argument', 'scheduledAt must be an ISO date-time string.');
  }

  const start = new Date(scheduledAt);
  if (Number.isNaN(start.getTime()) || start.getTime() <= Date.now()) {
    throw new HttpsError('invalid-argument', 'Choose a valid future walk time.');
  }

  const ref = await db.collection('bookings').add({
    customerId: request.auth.uid,
    city,
    durationMinutes,
    address: address.trim(),
    petName: petName.trim(),
    scheduledAt: Timestamp.fromDate(start),
    status: 'draft',
    paymentStatus: 'unpaid',
    createdAt: Timestamp.now(),
  });

  return { bookingId: ref.id, status: 'draft' };
});

// TODO: Add precise address/pincode serviceability checks, walker assignment,
// server-created payment orders and signed payment webhook verification.
// Never accept a client-supplied "paid" flag or payment status.
