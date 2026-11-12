import { initializeApp } from 'firebase-admin/app';
import { getFirestore, Timestamp } from 'firebase-admin/firestore';
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
    const pricingSnap = await db.collection('bookingPricing').doc(duration).get();
    const pricing = pricingSnap.data();
    const amountPaise = pricing?.active === true ? pricing.amountPaise : null;
    if (!Number.isSafeInteger(amountPaise) || amountPaise <= 0) {
      throw new HttpsError('failed-precondition', 'Pricing for ' + duration + ' minutes is not configured. Please contact DOJO WALK.');
    }
    const currency = 'INR';
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

