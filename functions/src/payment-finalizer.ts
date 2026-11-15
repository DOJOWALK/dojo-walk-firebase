import { Firestore, Timestamp } from 'firebase-admin/firestore';
import { decideCapturedPayment } from './payment-decision';

export type RazorpayPayment = {
  id: string;
  order_id: string;
  amount: number;
  currency: string;
  status: string;
  captured?: boolean;
  created_at?: number;
};

export async function finalizeCapturedRazorpayPayment(
  db: Firestore,
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
    const decision = decideCapturedPayment({
      bookingOrderId: booking.razorpayOrderId,
      bookingAmountPaise: booking.razorpayAmountPaise,
      bookingCurrency: booking.razorpayCurrency,
      paymentOrderId: payment.order_id,
      paymentAmountPaise: payment.amount,
      paymentCurrency: payment.currency,
      paymentStatus: payment.status,
      paymentCaptured: payment.captured,
      bookingPaymentStatus: booking.paymentStatus,
      bookingStatus: booking.status,
      reservationStatus: undefined,
      reservationExpiresAtMillis: undefined,
      nowMillis: Date.now(),
    });
    if (decision === 'reject') {
      throw new Error('Captured payment does not match the server-side order.');
    }

    const now = Timestamp.now();
    if (decision === 'duplicate_review') {
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
    const reservationIsValid = decideCapturedPayment({
      bookingOrderId: booking.razorpayOrderId,
      bookingAmountPaise: booking.razorpayAmountPaise,
      bookingCurrency: booking.razorpayCurrency,
      paymentOrderId: payment.order_id,
      paymentAmountPaise: payment.amount,
      paymentCurrency: payment.currency,
      paymentStatus: payment.status,
      paymentCaptured: payment.captured,
      bookingPaymentStatus: booking.paymentStatus,
      bookingStatus: booking.status,
      reservationStatus: reservationSnap?.exists ? reservation?.status : undefined,
      reservationExpiresAtMillis: reservation?.expiresAt instanceof Timestamp ? reservation.expiresAt.toMillis() : undefined,
      nowMillis: now.toMillis(),
    }) === 'confirm';

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

    if (reservationRef && reservationSnap?.exists === true
        && reservation?.status === 'held'
        && reservation?.expiresAt instanceof Timestamp
        && reservation.expiresAt.toMillis() <= now.toMillis()) {
      tx.update(reservationRef, { status: 'expired', expiredAt: now });
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

