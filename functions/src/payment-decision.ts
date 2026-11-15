export type CapturedPaymentDecision = 'reject' | 'duplicate_review' | 'confirm' | 'payment_review';

export interface CapturedPaymentFacts {
  bookingOrderId: unknown;
  bookingAmountPaise: unknown;
  bookingCurrency: unknown;
  paymentOrderId: unknown;
  paymentAmountPaise: unknown;
  paymentCurrency: unknown;
  paymentStatus: unknown;
  paymentCaptured: unknown;
  bookingPaymentStatus: unknown;
  bookingStatus: unknown;
  reservationStatus?: unknown;
  reservationExpiresAtMillis?: number;
  nowMillis: number;
}

/** Pure decision boundary for a Razorpay capture; Firestore writes stay transactional in the caller. */
export function decideCapturedPayment(facts: CapturedPaymentFacts): CapturedPaymentDecision {
  const matchesOrder = typeof facts.bookingOrderId === 'string'
    && facts.bookingOrderId === facts.paymentOrderId;
  const matchesAmount = Number.isSafeInteger(facts.bookingAmountPaise)
    && facts.bookingAmountPaise === facts.paymentAmountPaise
    && (facts.paymentAmountPaise as number) > 0;
  const matchesCurrency = facts.bookingCurrency === 'INR'
    && facts.paymentCurrency === facts.bookingCurrency;
  if (!matchesOrder || !matchesAmount || !matchesCurrency
      || facts.paymentStatus !== 'captured' || facts.paymentCaptured !== true) return 'reject';
  if (facts.bookingPaymentStatus === 'paid' || facts.bookingStatus === 'confirmed') return 'duplicate_review';
  const validReservation = facts.bookingStatus === 'walker_held'
    && facts.reservationStatus === 'held'
    && typeof facts.reservationExpiresAtMillis === 'number'
    && Number.isFinite(facts.reservationExpiresAtMillis)
    && facts.reservationExpiresAtMillis > facts.nowMillis;
  return validReservation ? 'confirm' : 'payment_review';
}
