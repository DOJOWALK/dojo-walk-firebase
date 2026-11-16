import { initializeApp } from 'firebase-admin/app';
import { getFirestore, Timestamp, DocumentReference, DocumentSnapshot } from 'firebase-admin/firestore';
import { onCall, onRequest, HttpsError } from 'firebase-functions/v2/https';
import { defineSecret } from 'firebase-functions/params';
import { createHash } from 'node:crypto';
import { hmacHex, safeHexEqual } from './security';
import { recurringLocalDateTimeToDate } from './schedule';
import { finalizeCapturedRazorpayPayment, type RazorpayPayment } from './payment-finalizer';
import { reserveWalkerTransaction } from './reservation';
import { setCustomerBookingSeriesStatus } from './series-lifecycle';
import { resolveWalkerBookingTransition } from './walker-lifecycle';
import {
  createRecurringOccurrenceBookingId,
  createRecurringRequestFingerprint,
  createRecurringSeriesId,
} from './recurring-identity';

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


const MAX_RECURRING_DAYS = 31;
const MAX_RECURRING_OCCURRENCES = 30;
const RECURRING_TIMEZONE = 'Asia/Kolkata';

export const createRecurringBookingSeries = onCall(async (request) => {
  if (!request.auth) {
    throw new HttpsError('unauthenticated', 'Sign in before creating a recurring schedule.');
  }
  const data = request.data ?? {};
  const idempotencyKey = typeof data.idempotencyKey === 'string'
    ? data.idempotencyKey.trim() : '';
  if (idempotencyKey.length < 8 || idempotencyKey.length > 100) {
    throw new HttpsError('invalid-argument', 'A valid recurring request ID is required.');
  }
  if (data.timezone !== RECURRING_TIMEZONE) {
    throw new HttpsError('invalid-argument', 'The initial recurring pilot supports Asia/Kolkata only.');
  }
  const { durationMinutes, address, petName, city, pincode, startDate, endDate } = data;
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
  if (typeof startDate !== 'string' || typeof endDate !== 'string') {
    throw new HttpsError('invalid-argument', 'Choose a recurring start date and end date.');
  }
  const startDateMatch = /^(\d{4})-(\d{2})-(\d{2})$/.exec(startDate);
  const endDateMatch = /^(\d{4})-(\d{2})-(\d{2})$/.exec(endDate);
  if (!startDateMatch || !endDateMatch) {
    throw new HttpsError('invalid-argument', 'Use YYYY-MM-DD for recurring dates.');
  }
  const startDay = Date.UTC(Number(startDateMatch[1]), Number(startDateMatch[2]) - 1, Number(startDateMatch[3]));
  const endDay = Date.UTC(Number(endDateMatch[1]), Number(endDateMatch[2]) - 1, Number(endDateMatch[3]));
  if (new Date(startDay).toISOString().slice(0, 10) !== startDate
      || new Date(endDay).toISOString().slice(0, 10) !== endDate) {
    throw new HttpsError('invalid-argument', 'A recurring start or end date is not a real calendar date.');
  }
  const dayCount = Math.floor((endDay - startDay) / 86400000) + 1;
  if (dayCount < 1 || dayCount > MAX_RECURRING_DAYS) {
    throw new HttpsError('invalid-argument', 'A recurring request can cover at most 31 calendar days.');
  }

  const weekdays = Array.isArray(data.weekdays) ? data.weekdays : [];
  if (weekdays.length === 0 || weekdays.length > 7
      || weekdays.some((day: unknown) => !Number.isInteger(day) || (day as number) < 0 || (day as number) > 6)
      || new Set(weekdays).size !== weekdays.length) {
    throw new HttpsError('invalid-argument', 'Select one or more unique weekdays (0 Sunday to 6 Saturday).');
  }
  const slots = Array.isArray(data.timeSlots) ? data.timeSlots : [];
  if (slots.length === 0 || slots.length > 2) {
    throw new HttpsError('invalid-argument', 'Select one or two daily time slots.');
  }
  const normalizedSlots = slots.map((slot: any) => ({
    id: typeof slot?.id === 'string' ? slot.id.trim() : '',
    localTime: typeof slot?.localTime === 'string' ? slot.localTime.trim() : '',
  }));
  const slotMinutes = normalizedSlots.map((slot: {localTime: string}) =>
    Number(slot.localTime.slice(0, 2)) * 60 + Number(slot.localTime.slice(3)));
  if (normalizedSlots.some((slot: {id: string; localTime: string}) =>
      !/^[a-zA-Z0-9_-]{1,24}$/.test(slot.id)
      || !/^([01]\d|2[0-3]):[0-5]\d$/.test(slot.localTime))
      || new Set(normalizedSlots.map((slot: {id: string}) => slot.id)).size !== normalizedSlots.length
      || new Set(normalizedSlots.map((slot: {localTime: string}) => slot.localTime)).size !== normalizedSlots.length
      || (slotMinutes.length === 2 && Math.abs(slotMinutes[0] - slotMinutes[1]) < durationMinutes)) {
    throw new HttpsError('invalid-argument',
      'Time slots must be unique and separated by at least the walk duration.');
  }
  if (typeof data.allowBackupWalker !== 'boolean') {
    throw new HttpsError('invalid-argument', 'Backup walker consent must be explicitly selected.');
  }

  const selectedWeekdays = new Set<number>(weekdays as number[]);
  const occurrences: Array<{localDate: string; slotId: string; localTime: string; scheduledAt: Date; endsAt: Date}> = [];
  for (let offset = 0; offset < dayCount; offset++) {
    const day = new Date(startDay + offset * 86400000);
    if (!selectedWeekdays.has(day.getUTCDay())) continue;
    const localDate = day.toISOString().slice(0, 10);
    for (const slot of normalizedSlots) {
      const scheduledAt = recurringLocalDateTimeToDate(localDate, slot.localTime);
      if (scheduledAt.getTime() <= Date.now()) {
        throw new HttpsError('invalid-argument', 'The recurring schedule contains a past walk time.');
      }
      occurrences.push({
        localDate,
        slotId: slot.id,
        localTime: slot.localTime,
        scheduledAt,
        endsAt: new Date(scheduledAt.getTime() + durationMinutes * 60000),
      });
    }
  }
  if (occurrences.length === 0 || occurrences.length > MAX_RECURRING_OCCURRENCES) {
    throw new HttpsError('invalid-argument',
      'Choose dates and weekdays that create between 1 and 30 individual walks.');
  }

  // Prices are read from admin-managed configuration; no amount is hardcoded.
  const pricingSnap = await db.collection('bookingPricing').doc(String(durationMinutes)).get();
  const pricing = pricingSnap.data();
  const amountPaise = pricing?.amountPaise;
  if (pricing?.active !== true || !Number.isSafeInteger(amountPaise) || amountPaise <= 0) {
    throw new HttpsError('failed-precondition',
      'Pricing for this walk duration is not configured. Please contact DOJO WALK.');
  }

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
  const allowBackupWalker = data.allowBackupWalker === true;
  const now = Timestamp.now();
  const quoteExpiresAt = Timestamp.fromMillis(now.toMillis() + PRICE_QUOTE_MINUTES * 60000);

  const prepared = await Promise.all(occurrences.map(async (occurrence) => {
    const available = await findAvailableWalkers(
      city, pincode, occurrence.scheduledAt, occurrence.endsAt,
    );
    const primaryAvailable = !!primaryWalkerId && available.includes(primaryWalkerId);
    const eligibleWalkerIds = primaryWalkerId
      ? [
          ...(primaryAvailable ? [primaryWalkerId] : []),
          ...(allowBackupWalker ? available.filter((id) => id !== primaryWalkerId) : []),
        ]
      : available;
    const occurrenceKey = occurrence.localDate + '_' + occurrence.slotId;
    const bookingId = createRecurringOccurrenceBookingId(
      request.auth!.uid, idempotencyKey, occurrence.localDate, occurrence.slotId,
    );
    return {
      ...occurrence,
      occurrenceKey,
      bookingId,
      eligibleWalkerIds,
      availabilityStatus: eligibleWalkerIds.length > 0 ? 'candidate_found' : 'no_candidate_window',
    };
  }));

  // Stable series ID makes client retries idempotent. A transaction creates the
  // series and its <=30 occurrence drafts atomically; no walker is held and no
  // payment is collected by this callable.
  const seriesId = createRecurringSeriesId(request.auth.uid, idempotencyKey);
  const requestFingerprint = createRecurringRequestFingerprint({
    durationMinutes,
    address: address.trim(),
    petName: petName.trim(),
    city,
    pincode,
    startDate,
    endDate,
    weekdays: [...selectedWeekdays],
    timeSlots: normalizedSlots,
    allowBackupWalker,
    timezone: RECURRING_TIMEZONE,
  });
  const seriesRef = db.collection('bookingSeries').doc(seriesId);
  const bookingRefs = prepared.map((item) => db.collection('bookings').doc(item.bookingId));
  const result = await db.runTransaction(async (tx) => {
    const existing = await tx.get(seriesRef);
    if (existing.exists) {
      if (existing.data()?.requestFingerprint !== requestFingerprint) {
        throw new HttpsError('failed-precondition',
          'This recurring request ID was already used with different schedule details.');
      }
      return {
        created: false,
        seriesId,
        bookingIds: Array.isArray(existing.data()?.occurrenceBookingIds)
          ? existing.data()!.occurrenceBookingIds as string[] : [],
        candidateOccurrenceCount: existing.data()?.candidateOccurrenceCount ?? 0,
        noCandidateWindowCount: existing.data()?.noCandidateWindowCount ?? 0,
      };
    }
    const seriesData = {
      customerId: request.auth!.uid,
      requestFingerprint,
      timezone: RECURRING_TIMEZONE,
      city,
      pincode,
      address: address.trim(),
      petName: petName.trim(),
      durationMinutes,
      weekdays: [...selectedWeekdays].sort(),
      timeSlots: normalizedSlots,
      startDate,
      endDate,
      primaryWalkerId: primaryWalkerId ?? null,
      allowBackupWalker,
      backupConsentAt: allowBackupWalker ? now : null,
      occurrenceBookingIds: prepared.map((item) => item.bookingId),
      occurrenceCount: prepared.length,
      candidateOccurrenceCount: prepared.filter((item) => item.eligibleWalkerIds.length > 0).length,
      noCandidateWindowCount: prepared.filter((item) => item.eligibleWalkerIds.length === 0).length,
      status: 'draft',
      createdAt: now,
      updatedAt: now,
    };
    tx.create(seriesRef, seriesData);
    prepared.forEach((item, index) => {
      const bookingRef = bookingRefs[index];
      tx.create(bookingRef, {
        customerId: request.auth!.uid,
        seriesId,
        occurrenceKey: item.occurrenceKey,
        localServiceDate: item.localDate,
        localServiceTime: item.localTime,
        timezone: RECURRING_TIMEZONE,
        city,
        pincode,
        durationMinutes,
        address: address.trim(),
        petName: petName.trim(),
        scheduledAt: Timestamp.fromDate(item.scheduledAt),
        endsAt: Timestamp.fromDate(item.endsAt),
        eligibleWalkerIds: item.eligibleWalkerIds,
        primaryWalkerId: primaryWalkerId ?? null,
        allowBackupWalker,
        backupConsentAt: allowBackupWalker ? now : null,
        availabilityStatus: item.availabilityStatus,
        quotedAmountPaise: amountPaise,
        quotedCurrency: 'INR',
        pricingVersion: pricing.version ?? null,
        pricingUpdatedAt: pricing.updatedAt instanceof Timestamp ? pricing.updatedAt : null,
        quotedAt: now,
        quoteExpiresAt,
        status: 'draft',
        paymentStatus: 'unpaid',
        createdAt: now,
      });
    });
    return {
      created: true,
      seriesId,
      bookingIds: prepared.map((item) => item.bookingId),
      candidateOccurrenceCount: prepared.filter((item) => item.eligibleWalkerIds.length > 0).length,
      noCandidateWindowCount: prepared.filter((item) => item.eligibleWalkerIds.length === 0).length,
    };
  });

  return {
    seriesId: result.seriesId,
    created: result.created,
    status: 'draft',
    timezone: RECURRING_TIMEZONE,
    occurrenceCount: result.bookingIds.length,
    occurrenceBookingIds: result.bookingIds,
    candidateOccurrenceCount: result.candidateOccurrenceCount,
    noCandidateWindowCount: result.noCandidateWindowCount,
    paymentCollected: false,
    walkersReserved: false,
  };
});


const HOLD_MINUTES = 10;
const PRICE_QUOTE_MINUTES = 30;

// Recurring occurrences can be scheduled weeks ahead, so their initial series
// quote is only indicative. Refresh one occurrence's admin-managed price when
// the customer is ready to confirm it; this does not reserve a walker or charge.
export const refreshRecurringOccurrenceQuote = onCall(async (request) => {
  if (!request.auth) {
    throw new HttpsError('unauthenticated', 'Sign in before refreshing a walk quote.');
  }
  const bookingId = request.data?.bookingId;
  if (typeof bookingId !== 'string' || !/^[a-f0-9]{40}$/.test(bookingId)) {
    throw new HttpsError('invalid-argument', 'A valid recurring walk ID is required.');
  }
  const bookingRef = db.collection('bookings').doc(bookingId);
  const bookingSnap = await bookingRef.get();
  if (!bookingSnap.exists || bookingSnap.data()?.customerId !== request.auth.uid) {
    throw new HttpsError('not-found', 'Recurring walk was not found.');
  }
  const booking = bookingSnap.data()!;
  if (typeof booking.seriesId !== 'string'
      || booking.status !== 'draft'
      || booking.paymentStatus !== 'unpaid'
      || ['creating', 'created', 'reconciliation_required'].includes(booking.paymentOrderStatus)
      || typeof booking.razorpayOrderId === 'string'
      || typeof booking.paymentId === 'string'
      || !(booking.scheduledAt instanceof Timestamp)
      || booking.scheduledAt.toMillis() <= Date.now()) {
    throw new HttpsError('failed-precondition',
      'Only an unpaid future recurring walk draft can receive a fresh quote.');
  }
  const pricingSnap = await db.collection('bookingPricing')
    .doc(String(booking.durationMinutes)).get();
  const pricing = pricingSnap.data();
  const amountPaise = pricing?.amountPaise;
  if (pricing?.active !== true || !Number.isSafeInteger(amountPaise) || amountPaise <= 0) {
    throw new HttpsError('failed-precondition',
      'Current pricing is unavailable for this walk. Please contact DOJO WALK.');
  }
  const now = Timestamp.now();
  const quoteExpiresAt = Timestamp.fromMillis(now.toMillis() + PRICE_QUOTE_MINUTES * 60000);
  const recurringSeriesRef = typeof booking.seriesId === 'string'
    ? db.collection('bookingSeries').doc(booking.seriesId) : null;
  await db.runTransaction(async (tx) => {
    const [fresh, seriesSnap] = await Promise.all([
      tx.get(bookingRef),
      recurringSeriesRef ? tx.get(recurringSeriesRef) : Promise.resolve(null),
    ]);
    if (recurringSeriesRef && (!seriesSnap?.exists || seriesSnap.data()?.status === 'paused')) {
      throw new HttpsError('failed-precondition', 'This recurring schedule is paused. Resume it before refreshing a walk quote.');
    }
    if (!fresh.exists || fresh.data()?.customerId !== request.auth!.uid
        || fresh.data()?.seriesId !== booking.seriesId
        || fresh.data()?.status !== 'draft'
        || fresh.data()?.paymentStatus !== 'unpaid'
        || ['creating', 'created', 'reconciliation_required'].includes(fresh.data()?.paymentOrderStatus)
        || typeof fresh.data()?.razorpayOrderId === 'string'
        || typeof fresh.data()?.paymentId === 'string'
        || !(fresh.data()?.scheduledAt instanceof Timestamp)
        || fresh.data()!.scheduledAt.toMillis() <= Date.now()) {
      throw new HttpsError('failed-precondition',
        'This recurring walk changed and can no longer be quoted.');
    }
    tx.update(bookingRef, {
      quotedAmountPaise: amountPaise,
      quotedCurrency: 'INR',
      pricingVersion: pricing.version ?? null,
      pricingUpdatedAt: pricing.updatedAt instanceof Timestamp ? pricing.updatedAt : null,
      quotedAt: now,
      quoteExpiresAt,
      updatedAt: now,
    });
  });
  return {
    bookingId,
    amountPaise,
    currency: 'INR',
    pricingVersion: pricing.version ?? null,
    quoteExpiresAt: quoteExpiresAt.toDate().toISOString(),
  };
});

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
  const holdExpired = booking.status === 'walker_held'
    && booking.reservationExpiresAt instanceof Timestamp
    && booking.reservationExpiresAt.toMillis() <= Date.now();
  const paymentOrderNeedsReconciliation = ['creating', 'created', 'reconciliation_required']
    .includes(booking.paymentOrderStatus)
    || typeof booking.razorpayOrderId === 'string'
    || typeof booking.paymentId === 'string';
  if (holdExpired && paymentOrderNeedsReconciliation) {
    throw new HttpsError('failed-precondition',
      'This booking has a payment order that must be reconciled before another walker can be reserved. Please contact support.');
  }
  if (holdExpired
      && typeof booking.walkerId === 'string'
      && typeof booking.reservationId === 'string') {
    await db.runTransaction(async (tx) => {
      const fresh = await tx.get(bookingRef);
      if (!fresh.exists) throw new HttpsError('not-found', 'Booking request was not found.');
      const current = fresh.data()!;
      if (current.status !== 'walker_held'
          || !(current.reservationExpiresAt instanceof Timestamp)
          || current.reservationExpiresAt.toMillis() > Date.now()) return;
      if (['creating', 'created', 'reconciliation_required'].includes(current.paymentOrderStatus)
          || typeof current.razorpayOrderId === 'string'
          || typeof current.paymentId === 'string') {
        throw new HttpsError('failed-precondition',
          'This booking has a payment order that must be reconciled before another walker can be reserved. Please contact support.');
      }
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
  // Do not place a walker hold against a price the customer can no longer
  // accept. Legacy drafts without quote fields retain the payment-time
  // compatibility path below.
  if (booking.quotedAmountPaise !== undefined
      && (!(booking.quoteExpiresAt instanceof Timestamp)
        || booking.quoteExpiresAt.toMillis() <= Date.now())) {
    throw new HttpsError('failed-precondition',
      'This price quote has expired. Refresh the price before checking walker availability.');
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
      const result = await reserveWalkerTransaction(db, {
        bookingRef,
        walkerRef,
        coverageRef,
        reservationRef,
        bookingId,
        customerId: request.auth!.uid,
        walkerId,
        expectedCity: booking.city,
        expectedPincode: booking.pincode,
        holdExpiresAt,
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
  const email = typeof data.email === 'string' ? data.email.trim().toLowerCase() : '';
  if (email && (email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))) {
    throw new HttpsError('invalid-argument', 'Enter a valid email address or leave it blank.');
  }
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
      email: email || null,
      applicationCity: city,
      applicationPincode: pincode,
      updatedAt: Timestamp.now(),
    }, { merge: true });
  } else {
    await ref.set({
      displayName,
      email: email || null,
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
    const transition = resolveWalkerBookingTransition({
      action,
      bookingStatus: booking.status,
      scheduledAtMillis: booking.scheduledAt.toMillis(),
      endsAtMillis: booking.endsAt.toMillis(),
      startedAtMillis: booking.startedAt instanceof Timestamp ? booking.startedAt.toMillis() : null,
      nowMillis: now.toMillis(),
    });
    if (!transition.ok) {
      const messages = {
        not_confirmed: 'Only confirmed walks can be started.',
        outside_start_window: 'You can start this walk from 30 minutes before its scheduled time until 2 hours after its planned end.',
        not_in_progress: 'Only an in-progress walk can be completed.',
        missing_started_at: 'This walk has no valid start time. Please contact DOJO WALK support.',
        too_early_to_complete: 'A walk must be in progress for at least 5 minutes before it can be completed.',
      };
      throw new HttpsError('failed-precondition', messages[transition.reason]);
    }
    if (transition.status === 'in_progress') {
      tx.update(bookingRef, { status: 'in_progress', startedAt: now, updatedAt: now });
      return 'in_progress';
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
        || booking.paymentStatus !== 'unpaid'
        || ['creating', 'created', 'reconciliation_required'].includes(booking.paymentOrderStatus)
        || typeof booking.razorpayOrderId === 'string'
        || typeof booking.paymentId === 'string') {
      throw new HttpsError('failed-precondition',
        'Only unpaid bookings with no payment order can be cancelled in the app. If payment was started, please contact support so the payment can be checked safely.');
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
    email: data.email ?? '',
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


export const pauseCustomerBookingSeries = onCall(async (request) => {
  if (!request.auth) {
    throw new HttpsError('unauthenticated', 'Sign in to pause your recurring schedule.');
  }
  const seriesId = request.data?.seriesId;
  if (typeof seriesId !== 'string' || !/^[a-f0-9]{40}$/.test(seriesId)) {
    throw new HttpsError('invalid-argument', 'A valid recurring schedule ID is required.');
  }
  const changed = await setCustomerBookingSeriesStatus(db, {
    seriesRef: db.collection('bookingSeries').doc(seriesId),
    customerId: request.auth.uid,
    action: 'pause',
  });
  return { seriesId, status: 'paused', changed };
});

export const resumeCustomerBookingSeries = onCall(async (request) => {
  if (!request.auth) {
    throw new HttpsError('unauthenticated', 'Sign in to resume your recurring schedule.');
  }
  const seriesId = request.data?.seriesId;
  if (typeof seriesId !== 'string' || !/^[a-f0-9]{40}$/.test(seriesId)) {
    throw new HttpsError('invalid-argument', 'A valid recurring schedule ID is required.');
  }
  const changed = await setCustomerBookingSeriesStatus(db, {
    seriesRef: db.collection('bookingSeries').doc(seriesId),
    customerId: request.auth.uid,
    action: 'resume',
  });
  return { seriesId, status: 'active', changed };
});

export const getCustomerBookingSeries = onCall(async (request) => {
  if (!request.auth) {
    throw new HttpsError('unauthenticated', 'Sign in to view your recurring schedules.');
  }
  const seriesId = request.data?.seriesId;
  if (typeof seriesId !== 'string' || !/^[a-f0-9]{40}$/.test(seriesId)) {
    throw new HttpsError('invalid-argument', 'A valid recurring schedule ID is required.');
  }
  const seriesSnap = await db.collection('bookingSeries').doc(seriesId).get();
  if (!seriesSnap.exists || seriesSnap.data()?.customerId !== request.auth.uid) {
    throw new HttpsError('not-found', 'Recurring schedule was not found.');
  }
  const series = seriesSnap.data()!;
  const occurrenceIds = Array.isArray(series.occurrenceBookingIds)
    ? series.occurrenceBookingIds.filter((id: unknown): id is string =>
        typeof id === 'string' && /^[a-f0-9]{40}$/.test(id)).slice(0, MAX_RECURRING_OCCURRENCES)
    : [];
  const snapshots = await Promise.all(occurrenceIds.map((id) =>
    db.collection('bookings').doc(id).get()));
  return {
    seriesId,
    status: series.status ?? 'draft',
    timezone: series.timezone ?? RECURRING_TIMEZONE,
    city: series.city ?? '',
    petName: series.petName ?? '',
    durationMinutes: series.durationMinutes ?? 0,
    occurrenceCount: series.occurrenceCount ?? occurrenceIds.length,
    candidateOccurrenceCount: series.candidateOccurrenceCount ?? 0,
    noCandidateWindowCount: series.noCandidateWindowCount ?? 0,
    paymentCollected: false,
    walkersReserved: false,
    occurrences: snapshots.filter((snap) => snap.exists
      && snap.data()?.customerId === request.auth!.uid).map((snap) => {
        const item = snap.data()!;
        return {
          bookingId: snap.id,
          localServiceDate: item.localServiceDate ?? '',
          localServiceTime: item.localServiceTime ?? '',
          durationMinutes: item.durationMinutes ?? 0,
          status: item.status ?? 'unknown',
          paymentStatus: item.paymentStatus ?? 'unpaid',
          availabilityStatus: item.availabilityStatus ?? 'unknown',
          quotedAmountPaise: item.quotedAmountPaise ?? null,
        };
      }).sort((left, right) =>
        (left.localServiceDate + left.localServiceTime)
          .localeCompare(right.localServiceDate + right.localServiceTime)),
  };
});

export const listCustomerBookingSeries = onCall(async (request) => {
  if (!request.auth) {
    throw new HttpsError('unauthenticated', 'Sign in to view your recurring schedules.');
  }
  const seriesSnapshot = await db.collection('bookingSeries')
    .where('customerId', '==', request.auth.uid)
    .orderBy('createdAt', 'desc')
    .limit(10)
    .get();
  const series = await Promise.all(seriesSnapshot.docs.map(async (seriesDoc) => {
    const data = seriesDoc.data();
    const occurrenceIds = Array.isArray(data.occurrenceBookingIds)
      ? data.occurrenceBookingIds.filter((id: unknown): id is string =>
          typeof id === 'string' && /^[a-f0-9]{40}$/.test(id)).slice(0, MAX_RECURRING_OCCURRENCES)
      : [];
    const snapshots = await Promise.all(occurrenceIds.map((id) =>
      db.collection('bookings').doc(id).get()));
    return {
      seriesId: seriesDoc.id,
      petName: data.petName ?? '',
      city: data.city ?? '',
      status: data.status ?? 'draft',
      createdAt: data.createdAt instanceof Timestamp ? data.createdAt.toDate().toISOString() : null,
      occurrences: snapshots.filter((snap) => snap.exists
        && snap.data()?.customerId === request.auth!.uid).map((snap) => {
          const item = snap.data()!;
          return {
            bookingId: snap.id,
            localServiceDate: item.localServiceDate ?? '',
            localServiceTime: item.localServiceTime ?? '',
            durationMinutes: item.durationMinutes ?? 0,
            status: item.status ?? 'unknown',
            paymentStatus: item.paymentStatus ?? 'unpaid',
            availabilityStatus: item.availabilityStatus ?? 'unknown',
            quotedAmountPaise: item.quotedAmountPaise ?? null,
          };
        }).sort((left, right) =>
          (left.localServiceDate + left.localServiceTime)
            .localeCompare(right.localServiceDate + right.localServiceTime)),
    };
  }));
  return { series };
});

export const listAdminBookingSeries = onCall(async (request) => {
  if (!request.auth || request.auth.token.admin !== true) {
    throw new HttpsError('permission-denied', 'Admin access is required.');
  }
  const seriesSnapshot = await db.collection('bookingSeries')
    .orderBy('createdAt', 'desc')
    .limit(10)
    .get();
  const series = await Promise.all(seriesSnapshot.docs.map(async (seriesDoc) => {
    const data = seriesDoc.data();
    const occurrenceIds = Array.isArray(data.occurrenceBookingIds)
      ? data.occurrenceBookingIds.filter((id: unknown): id is string =>
          typeof id === 'string' && /^[a-f0-9]{40}$/.test(id)).slice(0, 30)
      : [];
    const occurrenceSnapshots = await Promise.all(occurrenceIds.map((id) =>
      db.collection('bookings').doc(id).get()));
    return {
      seriesId: seriesDoc.id,
      customerId: data.customerId ?? '',
      petName: data.petName ?? '',
      city: data.city ?? '',
      pincode: data.pincode ?? '',
      address: data.address ?? '',
      durationMinutes: data.durationMinutes ?? 0,
      timezone: data.timezone ?? '',
      startDate: data.startDate ?? '',
      endDate: data.endDate ?? '',
      weekdays: Array.isArray(data.weekdays) ? data.weekdays : [],
      timeSlots: Array.isArray(data.timeSlots) ? data.timeSlots : [],
      allowBackupWalker: data.allowBackupWalker === true,
      status: data.status ?? 'unknown',
      occurrenceCount: data.occurrenceCount ?? occurrenceIds.length,
      candidateOccurrenceCount: data.candidateOccurrenceCount ?? 0,
      noCandidateWindowCount: data.noCandidateWindowCount ?? 0,
      createdAt: data.createdAt instanceof Timestamp ? data.createdAt.toDate().toISOString() : null,
      occurrences: occurrenceSnapshots.filter((snap) => snap.exists).map((snap) => {
        const occurrence = snap.data()!;
        return {
          bookingId: snap.id,
          localServiceDate: occurrence.localServiceDate ?? '',
          localServiceTime: occurrence.localServiceTime ?? '',
          status: occurrence.status ?? 'unknown',
          paymentStatus: occurrence.paymentStatus ?? 'unpaid',
          availabilityStatus: occurrence.availabilityStatus ?? 'unknown',
          walkerId: occurrence.walkerId ?? null,
          quotedAmountPaise: occurrence.quotedAmountPaise ?? null,
        };
      }).sort((left, right) =>
        (left.localServiceDate + left.localServiceTime)
          .localeCompare(right.localServiceDate + right.localServiceTime)),
    };
  }));
  return { series };
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

type RazorpayOrder = {
  id: string;
  amount: number;
  currency: string;
  status: string;
};

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

    const recurringSeriesRef = typeof booking.seriesId === 'string'
      ? db.collection('bookingSeries').doc(booking.seriesId) : null;
    try {
      await db.runTransaction(async (tx) => {
        const [freshBooking, reservationSnap, seriesSnap] = await Promise.all([
          tx.get(bookingRef),
          tx.get(reservationRef),
          recurringSeriesRef ? tx.get(recurringSeriesRef) : Promise.resolve(null),
        ]);
        if (recurringSeriesRef && (!seriesSnap?.exists || seriesSnap.data()?.status === 'paused')) {
          throw new HttpsError('failed-precondition', 'This recurring schedule is paused. Resume it before starting a new payment.');
        }
        if (!freshBooking.exists || freshBooking.data()?.customerId !== request.auth!.uid
            || freshBooking.data()?.status !== 'walker_held'
            || freshBooking.data()?.walkerId !== booking.walkerId
            || freshBooking.data()?.reservationId !== booking.reservationId
            || ['created', 'creating', 'reconciliation_required']
              .includes(freshBooking.data()?.paymentOrderStatus)
            || typeof freshBooking.data()?.razorpayOrderId === 'string'
            || typeof freshBooking.data()?.paymentId === 'string'
            || freshBooking.data()?.quotedAmountPaise !== amountPaise
            || freshBooking.data()?.quotedCurrency !== currency
            || !(freshBooking.data()?.quoteExpiresAt instanceof Timestamp)
            || freshBooking.data()!.quoteExpiresAt.toMillis() <= Date.now()
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
      return await finalizeCapturedRazorpayPayment(db, bookingId, payment, 'checkout');
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
      await finalizeCapturedRazorpayPayment(db, bookingId, payment, 'webhook');
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

