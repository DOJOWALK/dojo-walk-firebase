import { initializeApp } from 'firebase-admin/app';
import { getFirestore, Timestamp, DocumentReference, DocumentSnapshot } from 'firebase-admin/firestore';
import { onCall, onRequest, HttpsError } from 'firebase-functions/v2/https';
import { defineSecret } from 'firebase-functions/params';
import { createHmac, createHash, timingSafeEqual } from 'node:crypto';

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
  // Do not create drafts or hold walkers while this duration is unpriced/disabled.
  const pricingSnap = await db.collection('bookingPricing').doc(String(durationMinutes)).get();
  const configuredAmountPaise = pricingSnap.data()?.amountPaise;
  if (pricingSnap.data()?.active !== true
      || !Number.isSafeInteger(configuredAmountPaise)
      || configuredAmountPaise <= 0) {
    throw new HttpsError(
      'failed-precondition',
      'Pricing for ' + durationMinutes + ' minutes is not configured yet. Please contact DOJO WALK.',
    );
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

  // Keep continuity with the most recently confirmed/completed walk for the
  // same customer, pet and pincode. A different walker is a substitution and
  // is only considered when the owner explicitly opts in for this booking.
  const allowBackupWalker = data.allowBackupWalker === true;
  const recentBookings = await db.collection('bookings')
    .where('customerId', '==', request.auth.uid)
    .orderBy('createdAt', 'desc')
    .limit(50)
    .get();
  const primaryBooking = recentBookings.docs.find((doc) => {
    const previous = doc.data();
    return previous.petName === petName.trim()
      && previous.pincode === pincode
      && ['confirmed', 'completed'].includes(previous.status)
      && typeof previous.walkerId === 'string';
  });
  const primaryWalkerId = primaryBooking?.data().walkerId as string | undefined;
  const primaryIsAvailable = !!primaryWalkerId && availableWalkerIds.includes(primaryWalkerId);
  if (primaryWalkerId && !primaryIsAvailable && !allowBackupWalker) {
    throw new HttpsError(
      'failed-precondition',
      'Your regular walker is not available at this time. Allow a backup walker or choose another time.',
    );
  }
  const orderedWalkerIds = primaryWalkerId
    ? [
        ...(primaryIsAvailable ? [primaryWalkerId] : []),
        ...(allowBackupWalker ? availableWalkerIds.filter((id) => id !== primaryWalkerId) : []),
      ]
    : availableWalkerIds;

  // This creates a draft only. It does not reserve a walker or collect payment.
  const now = Timestamp.now();
  const quoteExpiresAt = Timestamp.fromMillis(now.toMillis() + PRICE_QUOTE_MINUTES * 60 * 1000);
  const pricingData = pricingSnap.data()!;
  const ref = await db.collection('bookings').add({
    customerId: request.auth.uid,
    city,
    pincode,
    durationMinutes,
    address: address.trim(),
    petName: petName.trim(),
    scheduledAt: Timestamp.fromDate(start),
    endsAt: Timestamp.fromDate(end),
    eligibleWalkerIds: orderedWalkerIds,
    primaryWalkerId: primaryWalkerId ?? null,
    allowBackupWalker,
    backupConsentAt: allowBackupWalker ? now : null,
    // Immutable customer-price quote for this booking. Later admin price edits
    // apply only to new booking drafts, never silently to this quote.
    quotedAmountPaise: configuredAmountPaise,
    quotedCurrency: 'INR',
    pricingVersion: pricingData.version ?? null,
    pricingUpdatedAt: pricingData.updatedAt instanceof Timestamp ? pricingData.updatedAt : null,
    quotedAt: now,
    quoteExpiresAt,
    status: 'draft',
    paymentStatus: 'unpaid',
    createdAt: now,
  });

  return {
    bookingId: ref.id,
    status: 'draft',
    amountPaise: configuredAmountPaise,
    currency: 'INR',
    quoteExpiresAt: quoteExpiresAt.toDate().toISOString(),
  };
});


const HOLD_MINUTES = 10;
const PRICE_QUOTE_MINUTES = 30;

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
  let booking = bookingSnap.data()!;
  if (booking.status === 'walker_held'
      && booking.reservationExpiresAt instanceof Timestamp
      && booking.reservationExpiresAt.toMillis() <= Date.now()
      && typeof booking.walkerId === 'string'
      && typeof booking.reservationId === 'string') {
    await db.runTransaction(async (tx) => {
      const fresh = await tx.get(bookingRef);
      if (!fresh.exists) throw new HttpsError('not-found', 'Booking request was not found.');
      const current = fresh.data()!;
      if (current.status !== 'walker_held'
          || !(current.reservationExpiresAt instanceof Timestamp)
          || current.reservationExpiresAt.toMillis() > Date.now()) return;
      const oldReservationRef = db.collection('walkers').doc(current.walkerId)
        .collection('reservations').doc(current.reservationId);
      const oldReservation = await tx.get(oldReservationRef);
      if (oldReservation.exists && oldReservation.data()?.status === 'held') {
        tx.update(oldReservationRef, { status: 'expired', expiredAt: Timestamp.now() });
      }
      tx.update(bookingRef, {
        status: 'draft',
        walkerId: null,
        reservationId: null,
        reservationExpiresAt: null,
        updatedAt: Timestamp.now(),
      });
    });
    const refreshed = await bookingRef.get();
    booking = refreshed.data()!;
  }
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
  const cityId = typeof booking.city === 'string' ? walkerCityConfig.get(booking.city) : undefined;
  if (!cityId || typeof booking.pincode !== 'string' || !/^\d{6}$/.test(booking.pincode)) {
    throw new HttpsError('failed-precondition', 'This booking has invalid service-area details.');
  }
  const coverageRef = db.doc(`serviceAreas/${cityId}/pincodes/${booking.pincode}`);

  for (const walkerId of candidates) {
    const walkerRef = db.collection('walkers').doc(walkerId);
    const reservationRef = walkerRef.collection('reservations').doc();
    const holdExpiresAt = Timestamp.fromMillis(Date.now() + HOLD_MINUTES * 60 * 1000);

    try {
      const result = await db.runTransaction(async (tx) => {
        const [freshBooking, walkerSnap, coverageSnap] = await Promise.all([
          tx.get(bookingRef),
          tx.get(walkerRef),
          tx.get(coverageRef),
        ]);
        if (!freshBooking.exists || freshBooking.data()?.customerId !== request.auth!.uid
            || freshBooking.data()?.status !== 'draft') {
          throw new HttpsError('failed-precondition', 'Booking is no longer available for reservation.');
        }
        // Use the transaction's fresh booking snapshot for every scheduling and
        // eligibility decision. The earlier read is only for candidate discovery;
        // it must never authorize a hold after the draft has been edited.
        const freshData = freshBooking.data()!;
        const freshEligibleIds = Array.isArray(freshData.eligibleWalkerIds)
          ? freshData.eligibleWalkerIds : [];
        if (!(freshData.scheduledAt instanceof Timestamp)
            || !(freshData.endsAt instanceof Timestamp)
            || freshData.scheduledAt.toMillis() <= Date.now()
            || freshData.city !== booking.city
            || freshData.pincode !== booking.pincode
            || !freshEligibleIds.includes(walkerId)) {
          throw new HttpsError('failed-precondition',
            'Booking details or walker eligibility changed. Please check availability again.');
        }
        const coverage = coverageSnap.data();
        const coveredWalkerIds = Array.isArray(coverage?.walkerIds)
          ? coverage.walkerIds.filter((id: unknown): id is string => typeof id === 'string')
          : [];
        if (!coverageSnap.exists || coverage?.enabled !== true
            || coverage.city !== booking.city || !coveredWalkerIds.includes(walkerId)
            || !walkerSnap.exists || walkerSnap.data()?.active !== true
            || !Array.isArray(walkerSnap.data()?.serviceablePincodes)
            || !walkerSnap.data()!.serviceablePincodes.includes(booking.pincode)) {
          return false;
        }

        const startAt = freshData.scheduledAt as Timestamp;
        const endAt = freshData.endsAt as Timestamp;
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


const walkerCityConfig = new Map([
  ['Noida', 'noida'],
  ['Greater Noida', 'greater-noida'],
  ['Ghaziabad', 'ghaziabad'],
]);

export const submitWalkerApplication = onCall(async (request) => {
  if (!request.auth) {
    throw new HttpsError('unauthenticated', 'Sign in before submitting a walker application.');
  }
  const data = request.data ?? {};
  const displayName = typeof data.displayName === 'string' ? data.displayName.trim() : '';
  const phone = typeof data.phone === 'string' ? data.phone.replace(/\D/g, '') : '';
  const verifiedTokenPhone = typeof request.auth.token.phone_number === 'string'
    ? request.auth.token.phone_number.replace(/\D/g, '').slice(-10)
    : '';
  if (verifiedTokenPhone && verifiedTokenPhone !== phone) {
    throw new HttpsError('permission-denied', 'The application phone must match your verified sign-in number.');
  }
  const city = typeof data.city === 'string' ? data.city : '';
  const pincode = typeof data.pincode === 'string' ? data.pincode.trim() : '';
  if (displayName.length < 2 || displayName.length > 80) {
    throw new HttpsError('invalid-argument', 'Enter your name (2 to 80 characters).');
  }
  if (!/^[6-9]\d{9}$/.test(phone)) {
    throw new HttpsError('invalid-argument', 'Enter a valid 10-digit Indian mobile number.');
  }
  if (!walkerCityConfig.has(city)) {
    throw new HttpsError('invalid-argument', 'Choose Noida, Greater Noida, or Ghaziabad.');
  }
  if (!/^\d{6}$/.test(pincode)) {
    throw new HttpsError('invalid-argument', 'Enter a valid 6-digit pincode.');
  }

  const ref = db.collection('walkers').doc(request.auth.uid);
  const existing = await ref.get();
  if (existing.exists && existing.data()?.active === true) {
    throw new HttpsError('already-exists', 'This walker account is already approved.');
  }
  if (existing.exists && existing.data()?.applicationStatus === 'pending') {
    await ref.set({
      displayName,
      phone,
      applicationCity: city,
      applicationPincode: pincode,
      updatedAt: Timestamp.now(),
    }, { merge: true });
  } else {
    await ref.set({
      displayName,
      email: request.auth.token.email ?? null,
      phone,
      applicationCity: city,
      applicationPincode: pincode,
      applicationStatus: 'pending',
      active: false,
      serviceablePincodes: [],
      createdAt: Timestamp.now(),
      updatedAt: Timestamp.now(),
    }, { merge: true });
  }
  return { status: 'pending', message: 'Your application was submitted for admin review.' };
});


export const saveWalkerAvailability = onCall(async (request) => {
  if (!request.auth) throw new HttpsError('unauthenticated', 'Sign in to update availability.');
  const uid = request.auth.uid;
  const walkerRef = db.collection('walkers').doc(uid);
  const walkerSnap = await walkerRef.get();
  if (!walkerSnap.exists || walkerSnap.data()?.active !== true
      || walkerSnap.data()?.applicationStatus !== 'approved') {
    throw new HttpsError('permission-denied', 'Only approved active walkers can set availability.');
  }
  const rawWindows = request.data?.windows;
  if (!Array.isArray(rawWindows) || rawWindows.length > 14) {
    throw new HttpsError('invalid-argument', 'Submit up to 14 availability windows at a time.');
  }
  const parsed = rawWindows.map((item: any) => {
    if (!item || typeof item.startAt !== 'string' || typeof item.endAt !== 'string') {
      throw new HttpsError('invalid-argument', 'Each availability window needs start and end times.');
    }
    const start = new Date(item.startAt);
    const end = new Date(item.endAt);
    if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())
        || start.getTime() <= Date.now() || end.getTime() <= start.getTime()
        || end.getTime() - start.getTime() > 16 * 60 * 60 * 1000) {
      throw new HttpsError('invalid-argument', 'Availability must be a future window no longer than 16 hours.');
    }
    return { start, end };
  }).sort((a, b) => a.start.getTime() - b.start.getTime());
  for (let i = 1; i < parsed.length; i++) {
    if (parsed[i].start.getTime() < parsed[i - 1].end.getTime()) {
      throw new HttpsError('invalid-argument', 'Availability windows cannot overlap.');
    }
  }
  const windowsRef = walkerRef.collection('availabilityWindows');
  const existing = await windowsRef.where('status', '==', 'available')
    .where('endAt', '>', Timestamp.now()).limit(400).get();
  const conflicts = existing.docs.some((doc) => {
    const data = doc.data();
    if (!(data.startAt instanceof Timestamp) || !(data.endAt instanceof Timestamp)) return false;
    return parsed.some(({ start, end }) =>
      start.getTime() < data.endAt.toMillis() && end.getTime() > data.startAt.toMillis());
  });
  if (conflicts) {
    throw new HttpsError('already-exists', 'This time overlaps with availability you already saved. Choose another time.');
  }
  const batch = db.batch();
  parsed.forEach(({ start, end }) => {
    const ref = windowsRef.doc();
    batch.set(ref, {
      startAt: Timestamp.fromDate(start),
      endAt: Timestamp.fromDate(end),
      status: 'available',
      updatedAt: Timestamp.now(),
      createdAt: Timestamp.now(),
    });
  });
  await batch.commit();
  return { saved: parsed.length };
});

export const updateWalkerBookingStatus = onCall(async (request) => {
  if (!request.auth) throw new HttpsError('unauthenticated', 'Sign in to update a walk.');
  const uid = request.auth.uid;
  const bookingId = request.data?.bookingId;
  const action = request.data?.action;
  if (typeof bookingId !== 'string' || !/^[A-Za-z0-9]{1,128}$/.test(bookingId)
      || !['start', 'complete'].includes(action)) {
    throw new HttpsError('invalid-argument', 'A valid booking and walk action are required.');
  }
  const walkerRef = db.collection('walkers').doc(uid);
  const bookingRef = db.collection('bookings').doc(bookingId);
  const now = Timestamp.now();
  const result = await db.runTransaction(async (tx) => {
    const [walkerSnap, bookingSnap] = await Promise.all([tx.get(walkerRef), tx.get(bookingRef)]);
    if (!walkerSnap.exists || walkerSnap.data()?.active !== true
        || walkerSnap.data()?.applicationStatus !== 'approved') {
      throw new HttpsError('permission-denied', 'Only approved active walkers can update walks.');
    }
    if (!bookingSnap.exists || bookingSnap.data()?.walkerId !== uid) {
      throw new HttpsError('not-found', 'This walk is not assigned to your account.');
    }
    const booking = bookingSnap.data()!;
    if (!(booking.scheduledAt instanceof Timestamp) || !(booking.endsAt instanceof Timestamp)) {
      throw new HttpsError('failed-precondition', 'This booking has invalid schedule details.');
    }
    if (action === 'start') {
      if (booking.status !== 'confirmed') {
        throw new HttpsError('failed-precondition', 'Only confirmed walks can be started.');
      }
      const earliest = booking.scheduledAt.toMillis() - 30 * 60 * 1000;
      const latest = booking.endsAt.toMillis() + 2 * 60 * 60 * 1000;
      if (now.toMillis() < earliest || now.toMillis() > latest) {
        throw new HttpsError('failed-precondition', 'You can start this walk from 30 minutes before its scheduled time until 2 hours after its planned end.');
      }
      tx.update(bookingRef, { status: 'in_progress', startedAt: now, updatedAt: now });
      return 'in_progress';
    }
    if (booking.status !== 'in_progress' || !(booking.startedAt instanceof Timestamp)) {
      throw new HttpsError('failed-precondition', 'Only an in-progress walk can be completed.');
    }
    if (now.toMillis() < booking.startedAt.toMillis() + 5 * 60 * 1000) {
      throw new HttpsError('failed-precondition', 'A walk must be in progress for at least 5 minutes before it can be completed.');
    }
    const reservationRef = typeof booking.reservationId === 'string'
      ? walkerRef.collection('reservations').doc(booking.reservationId) : null;
    const reservationSnap = reservationRef ? await tx.get(reservationRef) : null;
    tx.update(bookingRef, { status: 'completed', completedAt: now, updatedAt: now });
    if (reservationRef && reservationSnap?.exists) {
      tx.update(reservationRef, { status: 'completed', completedAt: now });
    }
    return 'completed';
  });
  return { bookingId, status: result };
});

export const getWalkerDashboard = onCall(async (request) => {
  if (!request.auth) throw new HttpsError('unauthenticated', 'Sign in to view walker dashboard.');
  const uid = request.auth.uid;
  const walkerSnap = await db.collection('walkers').doc(uid).get();
  if (!walkerSnap.exists || walkerSnap.data()?.active !== true
      || walkerSnap.data()?.applicationStatus !== 'approved') {
    throw new HttpsError('permission-denied', 'Walker account is not approved and active.');
  }
  const now = Timestamp.now();
  const [upcomingSnap, activeSnap] = await Promise.all([
    db.collection('bookings')
      .where('walkerId', '==', uid)
      .where('status', '==', 'confirmed')
      .where('scheduledAt', '>=', now)
      .orderBy('scheduledAt', 'asc')
      .limit(50)
      .get(),
    db.collection('bookings')
      .where('walkerId', '==', uid)
      .where('status', '==', 'in_progress')
      .orderBy('scheduledAt', 'asc')
      .limit(20)
      .get(),
  ]);
  const bookingDocs = [...activeSnap.docs, ...upcomingSnap.docs];
  const windowsSnap = await db.collection('walkers').doc(uid)
    .collection('availabilityWindows')
    .where('status', '==', 'available')
    .where('endAt', '>', now)
    .orderBy('startAt', 'asc')
    .limit(50)
    .get();
  return {
    walker: {
      displayName: walkerSnap.data()?.displayName ?? 'Walker',
      city: walkerSnap.data()?.applicationCity ?? '',
      pincode: walkerSnap.data()?.applicationPincode ?? '',
    },
    bookings: bookingDocs.map((doc) => {
      const data = doc.data();
      return {
        bookingId: doc.id,
        petName: data.petName ?? '',
        address: data.address ?? '',
        city: data.city ?? '',
        pincode: data.pincode ?? '',
        durationMinutes: data.durationMinutes ?? 0,
        quotedAmountPaise: Number.isSafeInteger(data.quotedAmountPaise) ? data.quotedAmountPaise : null,
        quotedCurrency: data.quotedCurrency ?? 'INR',
        scheduledAt: data.scheduledAt instanceof Timestamp ? data.scheduledAt.toDate().toISOString() : null,
        endsAt: data.endsAt instanceof Timestamp ? data.endsAt.toDate().toISOString() : null,
        paymentStatus: data.paymentStatus ?? '',
        status: data.status ?? 'confirmed',
        startedAt: data.startedAt instanceof Timestamp ? data.startedAt.toDate().toISOString() : null,
      };
    }),
    availability: windowsSnap.docs.map((doc) => {
      const data = doc.data();
      return {
        windowId: doc.id,
        startAt: data.startAt instanceof Timestamp ? data.startAt.toDate().toISOString() : null,
        endAt: data.endAt instanceof Timestamp ? data.endAt.toDate().toISOString() : null,
      };
    }),
  };
});

export const cancelCustomerBooking = onCall(async (request) => {
  if (!request.auth) throw new HttpsError('unauthenticated', 'Sign in to cancel a booking.');
  const bookingId = request.data?.bookingId;
  if (typeof bookingId !== 'string' || !/^[A-Za-z0-9]{1,128}$/.test(bookingId)) {
    throw new HttpsError('invalid-argument', 'A valid booking ID is required.');
  }
  const bookingRef = db.collection('bookings').doc(bookingId);
  const now = Timestamp.now();
  await db.runTransaction(async (tx) => {
    const bookingSnap = await tx.get(bookingRef);
    if (!bookingSnap.exists || bookingSnap.data()?.customerId !== request.auth!.uid) {
      throw new HttpsError('not-found', 'Booking was not found.');
    }
    const booking = bookingSnap.data()!;
    if (!['draft', 'walker_held'].includes(booking.status)
        || booking.paymentStatus !== 'unpaid') {
      throw new HttpsError('failed-precondition',
        'Only unpaid bookings before payment confirmation can be cancelled in the app. Please contact support for paid bookings.');
    }
    let reservationRef: DocumentReference | null = null;
    let reservationSnap: DocumentSnapshot | null = null;
    if (typeof booking.walkerId === 'string' && typeof booking.reservationId === 'string') {
      reservationRef = db.collection('walkers').doc(booking.walkerId)
        .collection('reservations').doc(booking.reservationId);
      reservationSnap = await tx.get(reservationRef);
    }
    tx.update(bookingRef, { status: 'cancelled', cancelledAt: now, updatedAt: now });
    if (reservationRef && reservationSnap?.exists
        && ['held', 'confirmed'].includes(reservationSnap.data()?.status)) {
      tx.update(reservationRef, { status: 'cancelled', cancelledAt: now, updatedAt: now });
    }
  });
  return { bookingId, status: 'cancelled' };
});

export const getCustomerBookings = onCall(async (request) => {
  if (!request.auth) throw new HttpsError('unauthenticated', 'Sign in to view your bookings.');
  const snap = await db.collection('bookings')
    .where('customerId', '==', request.auth.uid)
    .orderBy('createdAt', 'desc')
    .limit(50)
    .get();
  return {
    bookings: snap.docs.map((doc) => {
      const data = doc.data();
      return {
        bookingId: doc.id,
        petName: data.petName ?? '',
        city: data.city ?? '',
        pincode: data.pincode ?? '',
        address: data.address ?? '',
        durationMinutes: data.durationMinutes ?? 0,
        scheduledAt: data.scheduledAt instanceof Timestamp ? data.scheduledAt.toDate().toISOString() : null,
        endsAt: data.endsAt instanceof Timestamp ? data.endsAt.toDate().toISOString() : null,
        status: data.status ?? 'unknown',
        paymentStatus: data.paymentStatus ?? 'unpaid',
        createdAt: data.createdAt instanceof Timestamp ? data.createdAt.toDate().toISOString() : null,
      };
    }),
  };
});

export const getWalkerApplication = onCall(async (request) => {
  if (!request.auth) {
    throw new HttpsError('unauthenticated', 'Sign in to view your walker application.');
  }
  const snap = await db.collection('walkers').doc(request.auth.uid).get();
  if (!snap.exists) return { exists: false, status: 'not_submitted' };
  const data = snap.data()!;
  return {
    exists: true,
    status: data.applicationStatus ?? (data.active === true ? 'approved' : 'pending'),
    displayName: data.displayName ?? '',
    phone: data.phone ?? '',
    city: data.applicationCity ?? '',
    pincode: data.applicationPincode ?? '',
    active: data.active === true,
  };
});

export const listPendingWalkerApplications = onCall(async (request) => {
  if (!request.auth || request.auth.token.admin !== true) {
    throw new HttpsError('permission-denied', 'Admin access is required.');
  }
  const snap = await db.collection('walkers')
    .where('applicationStatus', '==', 'pending')
    .orderBy('createdAt', 'asc')
    .limit(100)
    .get();
  return {
    applications: snap.docs.map((doc) => {
      const data = doc.data();
      return {
        walkerId: doc.id,
        displayName: data.displayName ?? '',
        email: data.email ?? '',
        phone: data.phone ?? '',
        city: data.applicationCity ?? '',
        pincode: data.applicationPincode ?? '',
        createdAt: data.createdAt instanceof Timestamp ? data.createdAt.toDate().toISOString() : null,
      };
    }),
  };
});

export const listAdminBookings = onCall(async (request) => {
  if (!request.auth || request.auth.token.admin !== true) {
    throw new HttpsError('permission-denied', 'Admin access is required.');
  }
  const snap = await db.collection('bookings')
    .orderBy('createdAt', 'desc')
    .limit(100)
    .get();
  return {
    bookings: snap.docs.map((doc) => {
      const data = doc.data();
      return {
        bookingId: doc.id,
        customerId: data.customerId ?? '',
        walkerId: data.walkerId ?? null,
        primaryWalkerId: data.primaryWalkerId ?? null,
        allowBackupWalker: data.allowBackupWalker === true,
        backupConsentAt: data.backupConsentAt instanceof Timestamp
          ? data.backupConsentAt.toDate().toISOString() : null,
        petName: data.petName ?? '',
        city: data.city ?? '',
        pincode: data.pincode ?? '',
        address: data.address ?? '',
        durationMinutes: data.durationMinutes ?? 0,
        scheduledAt: data.scheduledAt instanceof Timestamp ? data.scheduledAt.toDate().toISOString() : null,
        status: data.status ?? 'unknown',
        paymentStatus: data.paymentStatus ?? 'unpaid',
        paymentReviewRequired: data.paymentReviewRequired === true,
        createdAt: data.createdAt instanceof Timestamp ? data.createdAt.toDate().toISOString() : null,
      };
    }),
  };
});

export const reviewWalkerApplication = onCall(async (request) => {
  if (!request.auth || request.auth.token.admin !== true) {
    throw new HttpsError('permission-denied', 'Admin access is required.');
  }
  const walkerId = request.data?.walkerId;
  const decision = request.data?.decision;
  if (typeof walkerId !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(walkerId)
      || !['approve', 'reject'].includes(decision)) {
    throw new HttpsError('invalid-argument', 'A valid walker ID and review decision are required.');
  }
  const walkerRef = db.collection('walkers').doc(walkerId);
  const walkerSnap = await walkerRef.get();
  if (!walkerSnap.exists || walkerSnap.data()?.applicationStatus !== 'pending') {
    throw new HttpsError('not-found', 'Pending walker application was not found.');
  }
  const application = walkerSnap.data()!;
  const now = Timestamp.now();

  if (decision === 'reject') {
    await walkerRef.update({
      applicationStatus: 'rejected',
      active: false,
      reviewedAt: now,
      reviewedBy: request.auth.uid,
      updatedAt: now,
    });
    return { walkerId, status: 'rejected' };
  }

  const city = application.applicationCity;
  const pincode = application.applicationPincode;
  const cityId = typeof city === 'string' ? walkerCityConfig.get(city) : undefined;
  if (!cityId || typeof pincode !== 'string' || !/^\d{6}$/.test(pincode)) {
    throw new HttpsError('failed-precondition', 'Walker application has invalid city or pincode data.');
  }
  const coverageRef = db.doc(`serviceAreas/${cityId}/pincodes/${pincode}`);
  await db.runTransaction(async (tx) => {
    const [freshWalker, coverageSnap] = await Promise.all([
      tx.get(walkerRef),
      tx.get(coverageRef),
    ]);
    if (!freshWalker.exists || freshWalker.data()?.applicationStatus !== 'pending') {
      throw new HttpsError('failed-precondition', 'This application has already been reviewed.');
    }
    const coverage = coverageSnap.data();
    if (!coverageSnap.exists || coverage?.enabled !== true || coverage.city !== city) {
      throw new HttpsError('failed-precondition', 'This pincode must be enabled by an admin before approving a walker.');
    }
    const walkerIds = Array.isArray(coverage.walkerIds)
      ? coverage.walkerIds.filter((id: unknown): id is string => typeof id === 'string')
      : [];
    if (!walkerIds.includes(walkerId)) walkerIds.push(walkerId);
    tx.update(walkerRef, {
      applicationStatus: 'approved',
      active: true,
      serviceablePincodes: [pincode],
      reviewedAt: now,
      reviewedBy: request.auth!.uid,
      updatedAt: now,
    });
    tx.set(coverageRef, { walkerIds, updatedAt: now }, { merge: true });
  });
  return { walkerId, status: 'approved', pincode };
});

const RAZORPAY_KEY_ID = defineSecret('RAZORPAY_KEY_ID');
const RAZORPAY_KEY_SECRET = defineSecret('RAZORPAY_KEY_SECRET');
const RAZORPAY_WEBHOOK_SECRET = defineSecret('RAZORPAY_WEBHOOK_SECRET');
const PAYMENT_WINDOW_MINUTES = 15;

type RazorpayPayment = {
  id: string;
  order_id: string;
  amount: number;
  currency: string;
  status: string;
  captured?: boolean;
  created_at?: number;
};

type RazorpayOrder = {
  id: string;
  amount: number;
  currency: string;
  status: string;
};

function safeHexEqual(expected: string, received: string): boolean {
  if (!/^[a-f0-9]{64}$/i.test(received)) return false;
  const left = Buffer.from(expected, 'hex');
  const right = Buffer.from(received, 'hex');
  return left.length === right.length && timingSafeEqual(left, right);
}

function hmacHex(secret: string, message: string): string {
  return createHmac('sha256', secret).update(message).digest('hex');
}

async function razorpayApi<T>(
  path: string,
  keyId: string,
  keySecret: string,
  method: 'GET' | 'POST',
  body?: Record<string, unknown>,
): Promise<T> {
  const response = await fetch('https://api.razorpay.com/v1' + path, {
    method,
    headers: {
      Authorization: 'Basic ' + Buffer.from(keyId + ':' + keySecret).toString('base64'),
      'Content-Type': 'application/json',
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const result = await response.json() as T & { error?: { description?: string } };
  if (!response.ok) {
    throw new Error(result.error?.description ?? ('Razorpay API returned ' + response.status));
  }
  return result;
}

async function fetchVerifiedCapturedPayment(
  orderId: string,
  paymentId: string,
  keyId: string,
  keySecret: string,
): Promise<RazorpayPayment> {
  const [payment, order] = await Promise.all([
    razorpayApi<RazorpayPayment>('/payments/' + encodeURIComponent(paymentId),
      keyId, keySecret, 'GET'),
    razorpayApi<RazorpayOrder>('/orders/' + encodeURIComponent(orderId),
      keyId, keySecret, 'GET'),
  ]);
  if (payment.order_id !== orderId || payment.status !== 'captured'
      || payment.captured !== true || order.id !== orderId
      || order.status !== 'paid' || payment.amount !== order.amount
      || payment.currency !== order.currency || order.currency !== 'INR') {
    throw new Error('Razorpay order/payment is not in a captured and paid state.');
  }
  return payment;
}

async function finalizeCapturedRazorpayPayment(
  bookingId: string,
  payment: RazorpayPayment,
  source: 'checkout' | 'webhook',
): Promise<{ status: string; bookingId: string }> {
  const bookingRef = db.collection('bookings').doc(bookingId);
  const paymentRef = db.collection('razorpayPayments').doc(payment.id);
  return db.runTransaction(async (tx) => {
    const [bookingSnap, paymentSnap] = await Promise.all([
      tx.get(bookingRef),
      tx.get(paymentRef),
    ]);
    if (!bookingSnap.exists) throw new Error('Booking does not exist.');
    const booking = bookingSnap.data()!;
    if (paymentSnap.exists) {
      if (paymentSnap.data()?.bookingId !== bookingId) {
        throw new Error('Payment ID is already linked to another booking.');
      }
      return { status: booking.status, bookingId };
    }
    if (booking.razorpayOrderId !== payment.order_id
        || booking.razorpayAmountPaise !== payment.amount
        || booking.razorpayCurrency !== payment.currency
        || payment.status !== 'captured'
        || payment.captured !== true) {
      throw new Error('Captured payment does not match the server-side order.');
    }

    const now = Timestamp.now();
    if (booking.paymentStatus === 'paid' || booking.status === 'confirmed') {
      tx.create(paymentRef, {
        bookingId,
        razorpayOrderId: payment.order_id,
        amountPaise: payment.amount,
        currency: payment.currency,
        status: 'captured_duplicate_review',
        source,
        capturedAt: payment.created_at
          ? Timestamp.fromMillis(payment.created_at * 1000)
          : now,
        recordedAt: now,
      });
      tx.update(bookingRef, {
        paymentReviewRequired: true,
        paymentReviewReason: 'An additional captured payment needs refund review.',
        updatedAt: now,
      });
      return { status: 'duplicate_payment_review', bookingId };
    }
    const reservationRef = typeof booking.walkerId === 'string'
      && typeof booking.reservationId === 'string'
      ? db.collection('walkers').doc(booking.walkerId)
          .collection('reservations').doc(booking.reservationId)
      : null;
    const reservationSnap = reservationRef ? await tx.get(reservationRef) : null;
    const reservation = reservationSnap?.data();
    const reservationIsValid = booking.status === 'walker_held'
      && reservationRef !== null
      && reservationSnap?.exists === true
      && reservation?.status === 'held'
      && reservation.expiresAt instanceof Timestamp
      && reservation.expiresAt.toMillis() > now.toMillis();

    tx.create(paymentRef, {
      bookingId,
      razorpayOrderId: payment.order_id,
      amountPaise: payment.amount,
      currency: payment.currency,
      status: 'captured',
      source,
      capturedAt: payment.created_at
        ? Timestamp.fromMillis(payment.created_at * 1000)
        : now,
      recordedAt: now,
    });

    if (reservationIsValid && reservationRef) {
      tx.update(reservationRef, {
        status: 'confirmed',
        paymentId: payment.id,
        confirmedAt: now,
      });
      tx.update(bookingRef, {
        status: 'confirmed',
        paymentStatus: 'paid',
        razorpayPaymentId: payment.id,
        paidAt: now,
        confirmedAt: now,
        updatedAt: now,
      });
      return { status: 'confirmed', bookingId };
    }

    tx.update(bookingRef, {
      status: 'payment_review',
      paymentStatus: 'paid',
      razorpayPaymentId: payment.id,
      paymentReviewRequired: true,
      paymentReviewReason: 'Payment captured after walker hold became invalid.',
      paidAt: now,
      updatedAt: now,
    });
    return { status: 'payment_review', bookingId };
  });
}

export const createRazorpayOrder = onCall(
  { secrets: [RAZORPAY_KEY_ID, RAZORPAY_KEY_SECRET] },
  async (request) => {
    if (!request.auth) {
      throw new HttpsError('unauthenticated', 'Sign in before starting payment.');
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
    if (booking.status !== 'walker_held'
        || typeof booking.walkerId !== 'string'
        || typeof booking.reservationId !== 'string'
        || !(booking.reservationExpiresAt instanceof Timestamp)
        || booking.reservationExpiresAt.toMillis() <= Date.now()) {
      throw new HttpsError('failed-precondition', 'Your walker hold has expired. Please check availability again.');
    }
    if (booking.paymentOrderStatus === 'created'
        && typeof booking.razorpayOrderId === 'string') {
      return {
        bookingId,
        orderId: booking.razorpayOrderId,
        amount: booking.razorpayAmountPaise,
        currency: booking.razorpayCurrency,
        keyId: RAZORPAY_KEY_ID.value(),
      };
    }
    if (booking.paymentOrderStatus === 'creating') {
      throw new HttpsError('aborted', 'Payment order creation is already in progress. Please retry shortly.');
    }
    if (booking.paymentOrderStatus === 'reconciliation_required') {
      throw new HttpsError('failed-precondition', 'Payment order outcome needs admin reconciliation. Do not retry payment yet.');
    }
    if (booking.paymentStatus === 'paid') {
      throw new HttpsError('already-exists', 'This booking has already been paid.');
    }

    const duration = String(booking.durationMinutes);
    let amountPaise = booking.quotedAmountPaise;
    let currency = booking.quotedCurrency;
    let quoteExpiresAt = booking.quoteExpiresAt;

    // Backward compatibility for drafts created before immutable quotes were
    // introduced: snapshot the current admin price once before creating an order.
    if (amountPaise === undefined || currency === undefined) {
      const pricingSnap = await db.collection('bookingPricing').doc(duration).get();
      const pricing = pricingSnap.data();
      amountPaise = pricing?.active === true ? pricing.amountPaise : null;
      currency = 'INR';
      quoteExpiresAt = Timestamp.fromMillis(Date.now() + PRICE_QUOTE_MINUTES * 60 * 1000);
      if (!Number.isSafeInteger(amountPaise) || amountPaise <= 0) {
        throw new HttpsError('failed-precondition', 'Pricing for ' + duration + ' minutes is not configured. Please contact DOJO WALK.');
      }
      await bookingRef.update({
        quotedAmountPaise: amountPaise,
        quotedCurrency: currency,
        pricingVersion: pricing?.version ?? null,
        pricingUpdatedAt: pricing?.updatedAt instanceof Timestamp ? pricing.updatedAt : null,
        quotedAt: Timestamp.now(),
        quoteExpiresAt,
        updatedAt: Timestamp.now(),
      });
    }

    if (!Number.isSafeInteger(amountPaise) || amountPaise <= 0 || currency !== 'INR'
        || !(quoteExpiresAt instanceof Timestamp) || quoteExpiresAt.toMillis() <= Date.now()) {
      throw new HttpsError('failed-precondition', 'This price quote has expired. Please create a new booking to see the current price.');
    }
    const lockId = db.collection('_paymentOrderLocks').doc().id;
    const reservationRef = db.collection('walkers').doc(booking.walkerId)
      .collection('reservations').doc(booking.reservationId);
    const paymentExpiresAt = Timestamp.fromMillis(Date.now() + PAYMENT_WINDOW_MINUTES * 60 * 1000);

    try {
      await db.runTransaction(async (tx) => {
        const [freshBooking, reservationSnap] = await Promise.all([
          tx.get(bookingRef),
          tx.get(reservationRef),
        ]);
        if (!freshBooking.exists || freshBooking.data()?.customerId !== request.auth!.uid
            || freshBooking.data()?.status !== 'walker_held'
            || freshBooking.data()?.paymentOrderStatus === 'created'
            || freshBooking.data()?.paymentOrderStatus === 'creating'
            || !reservationSnap.exists
            || reservationSnap.data()?.status !== 'held'
            || !(reservationSnap.data()?.expiresAt instanceof Timestamp)
            || reservationSnap.data()!.expiresAt.toMillis() <= Date.now()) {
          throw new HttpsError('failed-precondition', 'Walker hold is no longer valid for payment.');
        }
        tx.update(bookingRef, {
          paymentOrderStatus: 'creating',
          paymentOrderLockId: lockId,
          razorpayAmountPaise: amountPaise,
          razorpayCurrency: currency,
          paymentOrderStartedAt: Timestamp.now(),
          updatedAt: Timestamp.now(),
          reservationExpiresAt: paymentExpiresAt,
        });
        tx.update(reservationRef, {
          expiresAt: paymentExpiresAt,
          paymentWindowStartedAt: Timestamp.now(),
        });
      });
    } catch (error) {
      if (error instanceof HttpsError) throw error;
      throw new HttpsError('aborted', 'Could not lock the walker hold for payment.');
    }

    let order: { id: string; amount: number; currency: string; status: string };
    try {
      order = await razorpayApi('/orders', RAZORPAY_KEY_ID.value(),
        RAZORPAY_KEY_SECRET.value(), 'POST', {
          amount: amountPaise,
          currency,
          receipt: ('dw_' + bookingId).slice(0, 40),
          notes: {
            booking_id: bookingId,
            customer_uid: request.auth.uid,
            reservation_id: booking.reservationId,
          },
        });
      if (order.amount !== amountPaise || order.currency !== currency || order.status !== 'created') {
        throw new Error('Razorpay order response did not match the server price.');
      }
    } catch (_) {
      // The network may fail after Razorpay has accepted the order. Keep a
      // reconciliation lock so a client retry cannot accidentally create a second order.
      await db.runTransaction(async (tx) => {
        const fresh = await tx.get(bookingRef);
        if (fresh.exists && fresh.data()?.paymentOrderLockId === lockId) {
          tx.update(bookingRef, {
            paymentOrderStatus: 'reconciliation_required',
            paymentOrderErrorAt: Timestamp.now(),
            updatedAt: Timestamp.now(),
          });
        }
      });
      throw new HttpsError('failed-precondition', 'Payment order outcome is uncertain. Do not retry; support must reconcile the Razorpay order.');
    }

    await db.runTransaction(async (tx) => {
      const fresh = await tx.get(bookingRef);
      if (!fresh.exists || fresh.data()?.paymentOrderLockId !== lockId) {
        throw new HttpsError('aborted', 'Payment order state changed. Contact support before retrying.');
      }
      tx.update(bookingRef, {
        paymentOrderStatus: 'created',
        razorpayOrderId: order.id,
        razorpayAmountPaise: order.amount,
        razorpayCurrency: order.currency,
        paymentExpiresAt,
        updatedAt: Timestamp.now(),
      });
    });

    return {
      bookingId,
      orderId: order.id,
      amount: order.amount,
      currency: order.currency,
      keyId: RAZORPAY_KEY_ID.value(),
    };
  },
);

export const verifyRazorpayCheckout = onCall(
  { secrets: [RAZORPAY_KEY_ID, RAZORPAY_KEY_SECRET] },
  async (request) => {
    if (!request.auth) {
      throw new HttpsError('unauthenticated', 'Sign in to verify this payment.');
    }
    const { bookingId, paymentId, signature } = request.data ?? {};
    if (typeof bookingId !== 'string' || typeof paymentId !== 'string'
        || typeof signature !== 'string' || !/^pay_[A-Za-z0-9]+$/.test(paymentId)) {
      throw new HttpsError('invalid-argument', 'Payment verification details are invalid.');
    }
    const bookingRef = db.collection('bookings').doc(bookingId);
    const bookingSnap = await bookingRef.get();
    if (!bookingSnap.exists || bookingSnap.data()?.customerId !== request.auth.uid) {
      throw new HttpsError('not-found', 'Booking request was not found.');
    }
    const booking = bookingSnap.data()!;
    const orderId = booking.razorpayOrderId;
    if (typeof orderId !== 'string' || booking.paymentOrderStatus !== 'created') {
      throw new HttpsError('failed-precondition', 'No server-created Razorpay order exists for this booking.');
    }
    const expected = hmacHex(RAZORPAY_KEY_SECRET.value(), orderId + '|' + paymentId);
    if (!safeHexEqual(expected, signature)) {
      throw new HttpsError('permission-denied', 'Razorpay payment signature is invalid.');
    }
    let payment: RazorpayPayment;
    try {
      payment = await fetchVerifiedCapturedPayment(
        orderId, paymentId, RAZORPAY_KEY_ID.value(), RAZORPAY_KEY_SECRET.value(),
      );
    } catch (_) {
      throw new HttpsError('unavailable', 'Could not verify payment status with Razorpay.');
    }
    if (payment.order_id !== orderId || payment.status !== 'captured'
        || payment.captured !== true || payment.amount !== booking.razorpayAmountPaise
        || payment.currency !== 'INR') {
      throw new HttpsError('failed-precondition', 'Payment is not captured for this booking order yet.');
    }
    try {
      return await finalizeCapturedRazorpayPayment(bookingId, payment, 'checkout');
    } catch (_) {
      throw new HttpsError('failed-precondition', 'Payment was received but booking confirmation needs support review.');
    }
  },
);

export const razorpayWebhook = onRequest(
  { secrets: [RAZORPAY_KEY_ID, RAZORPAY_KEY_SECRET, RAZORPAY_WEBHOOK_SECRET] },
  async (request, response) => {
    if (request.method !== 'POST') {
      response.status(405).send('Method not allowed');
      return;
    }
    const signature = request.header('x-razorpay-signature') ?? '';
    const rawBody = request.rawBody;
    if (!rawBody || !safeHexEqual(
      hmacHex(RAZORPAY_WEBHOOK_SECRET.value(), rawBody.toString('utf8')),
      signature,
    )) {
      response.status(400).send('Invalid webhook signature');
      return;
    }

    let event: any;
    try {
      event = JSON.parse(rawBody.toString('utf8'));
    } catch (_) {
      response.status(400).send('Invalid JSON');
      return;
    }
    if (event.event !== 'payment.captured') {
      response.status(200).send('Event ignored');
      return;
    }

    const entity = event.payload?.payment?.entity;
    if (!entity || typeof entity.id !== 'string' || typeof entity.order_id !== 'string') {
      response.status(400).send('Missing payment entity');
      return;
    }
    const eventId = createHash('sha256')
      .update(request.header('x-razorpay-event-id') ?? rawBody)
      .digest('hex');
    const eventRef = db.collection('razorpayWebhookEvents').doc(eventId);

    try {
      const existingEvent = await eventRef.get();
      if (existingEvent.exists) {
        response.status(200).send('Duplicate event acknowledged');
        return;
      }
      const payment = await fetchVerifiedCapturedPayment(
        entity.order_id, entity.id, RAZORPAY_KEY_ID.value(), RAZORPAY_KEY_SECRET.value(),
      );
      const bookings = await db.collection('bookings')
        .where('razorpayOrderId', '==', payment.order_id)
        .limit(1).get();
      if (bookings.empty) {
        response.status(404).send('Order is not mapped to a booking');
        return;
      }
      const bookingId = bookings.docs[0].id;
      await finalizeCapturedRazorpayPayment(bookingId, payment, 'webhook');
      await eventRef.create({
        event: event.event,
        paymentId: payment.id,
        orderId: payment.order_id,
        processedAt: Timestamp.now(),
      });
      response.status(200).send('Webhook processed');
    } catch (_) {
      response.status(500).send('Webhook processing failed; retry delivery');
    }
  },
);

export const getBookingPaymentStatus = onCall(async (request) => {
  if (!request.auth) {
    throw new HttpsError('unauthenticated', 'Sign in to view booking status.');
  }
  const bookingId = request.data?.bookingId;
  if (typeof bookingId !== 'string' || !/^[A-Za-z0-9]{1,128}$/.test(bookingId)) {
    throw new HttpsError('invalid-argument', 'A valid booking ID is required.');
  }
  const snap = await db.collection('bookings').doc(bookingId).get();
  if (!snap.exists || snap.data()?.customerId !== request.auth.uid) {
    throw new HttpsError('not-found', 'Booking request was not found.');
  }
  const booking = snap.data()!;
  return {
    bookingId,
    status: booking.status,
    paymentStatus: booking.paymentStatus,
    paymentReviewRequired: booking.paymentReviewRequired === true,
  };
});

export const getBookingPricing = onCall(async (request) => {
  // Prices are non-sensitive and must be visible to signed-in customers.
  // Only setBookingPricing remains restricted to admins.
  if (!request.auth) {
    throw new HttpsError('unauthenticated', 'Sign in to view walk pricing.');
  }
  const durations = ['30', '45', '60'] as const;
  const snapshots = await Promise.all(
    durations.map((duration) => db.collection('bookingPricing').doc(duration).get()),
  );
  return Object.fromEntries(durations.map((duration, index) => {
    const data = snapshots[index].data();
    const amountPaise = Number.isSafeInteger(data?.amountPaise) && data!.amountPaise >= 0
      ? data!.amountPaise : 0;
    return [duration, {
      amountPaise,
      amountRupees: amountPaise / 100,
      active: data?.active === true && amountPaise > 0,
      currency: 'INR',
    }];
  }));
});

export const setBookingPricing = onCall(async (request) => {
  if (!request.auth || request.auth.token.admin !== true) {
    throw new HttpsError('permission-denied', 'Admin access is required.');
  }
  const duration = request.data?.duration;
  const amountRupees = request.data?.amountRupees;
  if (!['30', '45', '60'].includes(duration)
      || typeof amountRupees !== 'number'
      || !Number.isFinite(amountRupees)
      || amountRupees < 0
      || amountRupees > 100000
      || Math.abs(amountRupees * 100 - Math.round(amountRupees * 100)) > 1e-7) {
    throw new HttpsError('invalid-argument', 'Enter a valid non-negative price in rupees (up to two decimal places).');
  }
  const amountPaise = Math.round(amountRupees * 100);
  const now = Timestamp.now();
  const pricingRef = db.collection('bookingPricing').doc(duration);
  const auditRef = db.collection('pricingAuditLogs').doc();
  let previousAmountPaise: number | null = null;
  let version = 1;

  await db.runTransaction(async (tx) => {
    const currentSnap = await tx.get(pricingRef);
    const current = currentSnap.data();
    previousAmountPaise = Number.isSafeInteger(current?.amountPaise)
      ? current!.amountPaise : null;
    version = Number.isSafeInteger(current?.version) && current!.version > 0
      ? current!.version + 1 : 1;

    tx.set(pricingRef, {
      durationMinutes: Number(duration),
      amountPaise,
      currency: 'INR',
      active: amountPaise > 0,
      version,
      updatedAt: now,
      updatedBy: request.auth!.uid,
    }, { merge: true });

    tx.create(auditRef, {
      entityType: 'booking_duration_price',
      entityId: duration,
      durationMinutes: Number(duration),
      previousAmountPaise,
      newAmountPaise: amountPaise,
      currency: 'INR',
      previousActive: current?.active === true,
      newActive: amountPaise > 0,
      version,
      changedBy: request.auth!.uid,
      changedAt: now,
    });
  });

  return {
    duration,
    amountRupees,
    amountPaise,
    active: amountPaise > 0,
    version,
    previousAmountPaise,
  };
});

export const getPricingAuditLogs = onCall(async (request) => {
  if (!request.auth || request.auth.token.admin !== true) {
    throw new HttpsError('permission-denied', 'Admin access is required.');
  }
  const snapshot = await db.collection('pricingAuditLogs')
    .orderBy('changedAt', 'desc')
    .limit(50)
    .get();
  return {
    logs: snapshot.docs.map((doc) => {
      const data = doc.data();
      return {
        id: doc.id,
        durationMinutes: data.durationMinutes ?? 0,
        previousAmountPaise: data.previousAmountPaise ?? null,
        newAmountPaise: data.newAmountPaise ?? 0,
        previousActive: data.previousActive === true,
        newActive: data.newActive === true,
        version: data.version ?? 1,
        changedAt: data.changedAt instanceof Timestamp
          ? data.changedAt.toDate().toISOString() : null,
        changedBy: data.changedBy ?? '',
      };
    }),
  };
});

export const getAdminServiceAreas = onCall(async (request) => {
  if (!request.auth || request.auth.token.admin !== true) {
    throw new HttpsError('permission-denied', 'Admin access is required.');
  }
  const cityEntries = [...walkerCityConfig.entries()];
  const areas = await Promise.all(cityEntries.map(async ([city, cityId]) => {
    const snapshot = await db.collection('serviceAreas').doc(cityId)
      .collection('pincodes').get();
    return snapshot.docs.map((doc) => ({
      city,
      pincode: doc.id,
      enabled: doc.data().enabled === true,
      walkerCount: Array.isArray(doc.data().walkerIds) ? doc.data().walkerIds.length : 0,
    }));
  }));
  return { areas: areas.flat().sort((a, b) => a.city.localeCompare(b.city) || a.pincode.localeCompare(b.pincode)) };
});

export const setAdminServiceArea = onCall(async (request) => {
  if (!request.auth || request.auth.token.admin !== true) {
    throw new HttpsError('permission-denied', 'Admin access is required.');
  }
  const city = request.data?.city;
  const pincode = request.data?.pincode;
  const enabled = request.data?.enabled;
  const cityId = typeof city === 'string' ? walkerCityConfig.get(city) : undefined;
  if (!cityId || typeof pincode !== 'string' || !/^\d{6}$/.test(pincode)
      || typeof enabled !== 'boolean') {
    throw new HttpsError('invalid-argument', 'Choose a supported city, valid 6-digit pincode and enabled state.');
  }
  const ref = db.collection('serviceAreas').doc(cityId).collection('pincodes').doc(pincode);
  await db.runTransaction(async (tx) => {
    const current = await tx.get(ref);
    const existing = current.data() ?? {};
    tx.set(ref, {
      city,
      enabled,
      walkerIds: Array.isArray(existing.walkerIds) ? existing.walkerIds : [],
      updatedAt: Timestamp.now(),
      updatedBy: request.auth!.uid,
    }, { merge: true });
  });
  return { city, pincode, enabled };
});

