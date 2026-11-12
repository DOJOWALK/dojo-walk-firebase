import { initializeApp } from 'firebase-admin/app';
import { getFirestore, Timestamp } from 'firebase-admin/firestore';
import { onCall, HttpsError } from 'firebase-functions/v2/https';

initializeApp();
const db = getFirestore();
const allowedDurations = new Set([30, 45, 60]);
const cityConfig = new Map([
  ['Noida', 'noida'],
  ['Greater Noida', 'greater-noida'],
  ['Ghaziabad', 'ghaziabad'],
]);

async function findAvailableWalkers(city: string, pincode: string, start: Date, end: Date) {
  const cityId = cityConfig.get(city);
  if (!cityId) return [];

  // This document is populated only after the pincode has been verified by an admin.
  const coverageRef = db.doc(`serviceAreas/${cityId}/pincodes/${pincode}`);
  const coverageSnap = await coverageRef.get();
  if (!coverageSnap.exists) return [];

  const coverage = coverageSnap.data();
  if (coverage?.enabled !== true || coverage.city !== city) return [];
  const walkerIds = Array.isArray(coverage.walkerIds)
    ? coverage.walkerIds.filter((id: unknown): id is string =>
        typeof id === 'string' && id.length > 0 && id.length <= 128)
    : [];

  const endTimestamp = Timestamp.fromDate(end);
  const startTimestamp = Timestamp.fromDate(start);
  const eligible = await Promise.all(walkerIds.slice(0, 100).map(async (walkerId) => {
    const walkerRef = db.doc(`walkers/${walkerId}`);
    const walkerSnap = await walkerRef.get();
    if (!walkerSnap.exists) return null;
    const walker = walkerSnap.data();
    if (walker?.active !== true || !Array.isArray(walker.serviceablePincodes)
        || !walker.serviceablePincodes.includes(pincode)) return null;

    // Availability windows must fully contain the requested walk interval.
    const windows = await walkerRef.collection('availabilityWindows')
      .where('status', '==', 'available')
      .where('startAt', '<=', startTimestamp)
      .where('endAt', '>=', endTimestamp)
      .limit(1)
      .get();
    return windows.empty ? null : walkerId;
  }));

  return eligible.filter((id): id is string => id !== null);
}

export const createBookingDraft = onCall(async (request) => {
  if (!request.auth) {
    throw new HttpsError('unauthenticated', 'Sign in to create a booking.');
  }

  const data = request.data ?? {};
  const { durationMinutes, scheduledAt, address, petName, city, pincode } = data;

  if (!Number.isInteger(durationMinutes) || !allowedDurations.has(durationMinutes)) {
    throw new HttpsError('invalid-argument', 'Duration must be 30, 45, or 60 minutes.');
  }
  if (typeof city !== 'string' || !cityConfig.has(city)) {
    throw new HttpsError('failed-precondition', 'This city is not in the initial launch area.');
  }
  if (typeof pincode !== 'string' || !/^\d{6}$/.test(pincode)) {
    throw new HttpsError('invalid-argument', 'Enter a valid 6-digit service pincode.');
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
  const end = new Date(start.getTime() + durationMinutes * 60 * 1000);

  const availableWalkerIds = await findAvailableWalkers(city, pincode, start, end);
  if (availableWalkerIds.length === 0) {
    throw new HttpsError(
      'failed-precondition',
      'This pincode or time is not serviceable yet. Please choose another time or contact support.',
    );
  }

  // This creates a draft only. It does not reserve a walker or collect payment.
  const ref = await db.collection('bookings').add({
    customerId: request.auth.uid,
    city,
    pincode,
    durationMinutes,
    address: address.trim(),
    petName: petName.trim(),
    scheduledAt: Timestamp.fromDate(start),
    endsAt: Timestamp.fromDate(end),
    eligibleWalkerIds: availableWalkerIds,
    status: 'draft',
    paymentStatus: 'unpaid',
    createdAt: Timestamp.now(),
  });

  return { bookingId: ref.id, status: 'draft' };
});


const HOLD_MINUTES = 10;

export const reserveWalkerForBooking = onCall(async (request) => {
  if (!request.auth) {
    throw new HttpsError('unauthenticated', 'Sign in to reserve a walker.');
  }
  const bookingId = request.data?.bookingId;
  if (typeof bookingId !== 'string' || !/^[A-Za-z0-9]{1,128}$/.test(bookingId)) {
    throw new HttpsError('invalid-argument', 'A valid booking ID is required.');
  }

  const bookingRef = db.collection('bookings').doc(bookingId);
  const bookingSnap = await bookingRef.get();
  if (!bookingSnap.exists || bookingSnap.data()?.customerId !== request.auth.uid) {
    throw new HttpsError('not-found', 'Booking request was not found.');
  }
  const booking = bookingSnap.data()!;
  if (booking.status !== 'draft' || !(booking.scheduledAt instanceof Timestamp)
      || !(booking.endsAt instanceof Timestamp) || !Array.isArray(booking.eligibleWalkerIds)) {
    throw new HttpsError('failed-precondition', 'This booking is not ready for walker reservation.');
  }
  if (booking.scheduledAt.toMillis() <= Date.now()) {
    throw new HttpsError('failed-precondition', 'The requested walk time has passed.');
  }

  const candidates = booking.eligibleWalkerIds
    .filter((id: unknown): id is string =>
      typeof id === 'string' && id.length > 0 && id.length <= 128)
    .slice(0, 100);

  for (const walkerId of candidates) {
    const walkerRef = db.collection('walkers').doc(walkerId);
    const reservationRef = walkerRef.collection('reservations').doc();
    const holdExpiresAt = Timestamp.fromMillis(Date.now() + HOLD_MINUTES * 60 * 1000);

    try {
      const result = await db.runTransaction(async (tx) => {
        const [freshBooking, walkerSnap] = await Promise.all([
          tx.get(bookingRef),
          tx.get(walkerRef),
        ]);
        if (!freshBooking.exists || freshBooking.data()?.customerId !== request.auth!.uid
            || freshBooking.data()?.status !== 'draft') {
          throw new HttpsError('failed-precondition', 'Booking is no longer available for reservation.');
        }
        if (!walkerSnap.exists || walkerSnap.data()?.active !== true
            || !Array.isArray(walkerSnap.data()?.serviceablePincodes)
            || !walkerSnap.data()!.serviceablePincodes.includes(booking.pincode)) {
          return false;
        }

        const startAt = booking.scheduledAt as Timestamp;
        const endAt = booking.endsAt as Timestamp;
        const windowsQuery = walkerRef.collection('availabilityWindows')
          .where('status', '==', 'available')
          .where('startAt', '<=', startAt)
          .where('endAt', '>=', endAt)
          .limit(1);
        const overlapsQuery = walkerRef.collection('reservations')
          .where('startAt', '<', endAt)
          .limit(100);
        const [windows, overlaps] = await Promise.all([
          tx.get(windowsQuery),
          tx.get(overlapsQuery),
        ]);
        if (windows.empty) return false;

        const now = Timestamp.now();
        const hasConflict = overlaps.docs.some((doc) => {
          const data = doc.data();
          const active = data.status === 'confirmed'
            || (data.status === 'held'
              && data.expiresAt instanceof Timestamp
              && data.expiresAt.toMillis() > now.toMillis());
          return active
            && data.endAt instanceof Timestamp
            && data.endAt.toMillis() > startAt.toMillis();
        });
        if (hasConflict) return false;

        // Updating the walker document makes concurrent reservations contend on one
        // shared document, preventing two overlapping holds from both committing.
        tx.update(walkerRef, {
          reservationVersion: (walkerSnap.data()?.reservationVersion ?? 0) + 1,
          updatedAt: now,
        });
        tx.create(reservationRef, {
          bookingId,
          customerId: request.auth!.uid,
          startAt,
          endAt,
          status: 'held',
          expiresAt: holdExpiresAt,
          createdAt: now,
        });
        tx.update(bookingRef, {
          walkerId,
          reservationId: reservationRef.id,
          reservationExpiresAt: holdExpiresAt,
          status: 'walker_held',
          updatedAt: now,
        });
        return true;
      });

      if (result) {
        return {
          bookingId,
          walkerId,
          reservationId: reservationRef.id,
          status: 'walker_held',
          expiresAt: holdExpiresAt.toDate().toISOString(),
          holdMinutes: HOLD_MINUTES,
        };
      }
    } catch (error) {
      if (error instanceof HttpsError) throw error;
      // A contention/retry failure on one walker should allow trying the next candidate.
    }
  }

  throw new HttpsError(
    'failed-precondition',
    'All matching walkers are currently booked. Please choose another time.',
  );
});

export const releaseWalkerHold = onCall(async (request) => {
  if (!request.auth) {
    throw new HttpsError('unauthenticated', 'Sign in to release this walker hold.');
  }
  const bookingId = request.data?.bookingId;
  if (typeof bookingId !== 'string' || !/^[A-Za-z0-9]{1,128}$/.test(bookingId)) {
    throw new HttpsError('invalid-argument', 'A valid booking ID is required.');
  }
  const bookingRef = db.collection('bookings').doc(bookingId);
  await db.runTransaction(async (tx) => {
    const bookingSnap = await tx.get(bookingRef);
    if (!bookingSnap.exists || bookingSnap.data()?.customerId !== request.auth!.uid) {
      throw new HttpsError('not-found', 'Booking request was not found.');
    }
    const booking = bookingSnap.data()!;
    if (booking.status !== 'walker_held' || typeof booking.walkerId !== 'string'
        || typeof booking.reservationId !== 'string') {
      throw new HttpsError('failed-precondition', 'This booking has no active walker hold.');
    }
    const reservationRef = db.collection('walkers').doc(booking.walkerId)
      .collection('reservations').doc(booking.reservationId);
    const reservationSnap = await tx.get(reservationRef);
    if (reservationSnap.exists && reservationSnap.data()?.status === 'held') {
      tx.update(reservationRef, {
        status: 'released',
        releasedAt: Timestamp.now(),
      });
    }
    tx.update(bookingRef, {
      status: 'draft',
      walkerId: null,
      reservationId: null,
      reservationExpiresAt: null,
      updatedAt: Timestamp.now(),
    });
  });
  return { bookingId, status: 'draft', walkerReleased: true };
});
