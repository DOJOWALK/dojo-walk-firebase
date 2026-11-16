import { getApps, initializeApp } from 'firebase-admin/app';
import { getFirestore, Timestamp } from 'firebase-admin/firestore';
import { onCall, onRequest, HttpsError } from 'firebase-functions/v2/https';
import { defineSecret } from 'firebase-functions/params';
import { createHash } from 'node:crypto';
import { hmacHex, safeHexEqual } from './security';
import { finalizeCapturedRazorpayPayment, type RazorpayPayment } from './payment-finalizer';

// This module is intentionally not imported by index.ts while online payments
// are disabled. Re-export its functions from index.ts when Razorpay is ready.
if (getApps().length === 0) initializeApp();
const db = getFirestore();

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
