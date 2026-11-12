import { initializeApp } from 'firebase-admin/app';
import { getFirestore, Timestamp } from 'firebase-admin/firestore';
import { onCall, HttpsError } from 'firebase-functions/v2/https';

initializeApp();
const db = getFirestore();
const allowedDurations = [30, 45, 60];

export const createBookingDraft = onCall(async (request) => {
  if (!request.auth) throw new HttpsError('unauthenticated', 'Sign in to create a booking.');
  const { durationMinutes, scheduledAt, address, petName } = request.data ?? {};
  if (!allowedDurations.includes(durationMinutes)) throw new HttpsError('invalid-argument', 'Duration must be 30, 45, or 60 minutes.');
  if (typeof address !== 'string' || !address.trim()) throw new HttpsError('invalid-argument', 'A walk address is required.');
  if (typeof petName !== 'string' || !petName.trim()) throw new HttpsError('invalid-argument', 'Pet name is required.');
  const start = new Date(scheduledAt);
  if (!scheduledAt || Number.isNaN(start.getTime()) || start.getTime() < Date.now()) throw new HttpsError('invalid-argument', 'Choose a future walk time.');
  const ref = await db.collection('bookings').add({
    customerId: request.auth.uid, durationMinutes, address: address.trim(), petName: petName.trim(),
    scheduledAt: Timestamp.fromDate(start), status: 'draft', paymentStatus: 'unpaid', createdAt: Timestamp.now(),
  });
  return { bookingId: ref.id, status: 'draft' };
});

// TODO: Add walker assignment, cancellation policy, payment order creation and
// signed webhook verification. Never mark a booking paid from a client request.
