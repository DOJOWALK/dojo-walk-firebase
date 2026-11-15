import { Firestore, DocumentReference, Timestamp } from 'firebase-admin/firestore';
import { HttpsError } from 'firebase-functions/v2/https';

export async function reserveWalkerTransaction(
  db: Firestore,
  args: {
    bookingRef: DocumentReference;
    walkerRef: DocumentReference;
    coverageRef: DocumentReference;
    reservationRef: DocumentReference;
    bookingId: string;
    customerId: string;
    walkerId: string;
    expectedCity: string;
    expectedPincode: string;
    holdExpiresAt: Timestamp;
  },
): Promise<boolean> {
  const {
    bookingRef, walkerRef, coverageRef, reservationRef,
    bookingId, customerId, walkerId, expectedCity, expectedPincode, holdExpiresAt,
  } = args;

  return db.runTransaction(async (tx) => {
    const [freshBooking, walkerSnap, coverageSnap] = await Promise.all([
      tx.get(bookingRef), tx.get(walkerRef), tx.get(coverageRef),
    ]);
    if (!freshBooking.exists || freshBooking.data()?.customerId !== customerId
        || freshBooking.data()?.status !== 'draft') {
      throw new HttpsError('failed-precondition', 'Booking is no longer available for reservation.');
    }

    // Candidate discovery is advisory only; all authorization uses fresh transactional data.
    const freshData = freshBooking.data()!;
    const freshEligibleIds = Array.isArray(freshData.eligibleWalkerIds)
      ? freshData.eligibleWalkerIds : [];
    if (!(freshData.scheduledAt instanceof Timestamp)
        || !(freshData.endsAt instanceof Timestamp)
        || freshData.scheduledAt.toMillis() <= Date.now()
        || freshData.city !== expectedCity
        || freshData.pincode !== expectedPincode
        || !freshEligibleIds.includes(walkerId)) {
      throw new HttpsError('failed-precondition',
        'Booking details or walker eligibility changed. Please check availability again.');
    }

    const coverage = coverageSnap.data();
    const coveredWalkerIds = Array.isArray(coverage?.walkerIds)
      ? coverage.walkerIds.filter((id: unknown): id is string => typeof id === 'string')
      : [];
    const walker = walkerSnap.data();
    if (!coverageSnap.exists || coverage?.enabled !== true
        || coverage.city !== expectedCity || !coveredWalkerIds.includes(walkerId)
        || !walkerSnap.exists || walker?.active !== true
        || !Array.isArray(walker.serviceablePincodes)
        || !walker.serviceablePincodes.includes(expectedPincode)) {
      return false;
    }

    const startAt = freshData.scheduledAt;
    const endAt = freshData.endsAt;
    const configuredBuffer = walker.travelBufferMinutes;
    const bufferMinutes = Number.isInteger(configuredBuffer)
      && configuredBuffer >= 0 && configuredBuffer <= 120 ? configuredBuffer : 15;
    const bufferMillis = bufferMinutes * 60 * 1000;
    const bufferedStartAt = Timestamp.fromMillis(startAt.toMillis() - bufferMillis);
    const bufferedEndAt = Timestamp.fromMillis(endAt.toMillis() + bufferMillis);

    const windowsQuery = walkerRef.collection('availabilityWindows')
      .where('status', '==', 'available')
      .where('startAt', '<=', startAt)
      .where('endAt', '>=', endAt)
      .limit(1);
    // Query enough surrounding time to include every previously stored (max 120m) buffer.
    const maxStoredBufferMillis = 120 * 60 * 1000;
    const overlapQueryStart = Timestamp.fromMillis(bufferedStartAt.toMillis() - maxStoredBufferMillis);
    const overlapQueryEnd = Timestamp.fromMillis(bufferedEndAt.toMillis() + maxStoredBufferMillis);
    const overlapsQuery = walkerRef.collection('reservations')
      .where('startAt', '<', overlapQueryEnd)
      .where('endAt', '>', overlapQueryStart);
    const [windows, overlaps] = await Promise.all([tx.get(windowsQuery), tx.get(overlapsQuery)]);
    if (windows.empty) return false;

    const now = Timestamp.now();
    const hasConflict = overlaps.docs.some((doc) => {
      const data = doc.data();
      const active = data.status === 'confirmed'
        || (data.status === 'held' && data.expiresAt instanceof Timestamp
          && data.expiresAt.toMillis() > now.toMillis());
      if (!active || !(data.startAt instanceof Timestamp) || !(data.endAt instanceof Timestamp)) return false;
      const existingBefore = Number.isInteger(data.bufferBeforeMinutes)
        && data.bufferBeforeMinutes >= 0 && data.bufferBeforeMinutes <= 120
        ? data.bufferBeforeMinutes : 15;
      const existingAfter = Number.isInteger(data.bufferAfterMinutes)
        && data.bufferAfterMinutes >= 0 && data.bufferAfterMinutes <= 120
        ? data.bufferAfterMinutes : 15;
      const existingBufferedStart = data.startAt.toMillis() - existingBefore * 60000;
      const existingBufferedEnd = data.endAt.toMillis() + existingAfter * 60000;
      return existingBufferedStart < bufferedEndAt.toMillis()
        && existingBufferedEnd > bufferedStartAt.toMillis();
    });
    if (hasConflict) return false;

    // Shared walker-document write forces overlapping transactions to contend and retry.
    tx.update(walkerRef, {
      reservationVersion: (walker.reservationVersion ?? 0) + 1,
      updatedAt: now,
    });
    tx.create(reservationRef, {
      bookingId, customerId, startAt, endAt,
      bufferBeforeMinutes: bufferMinutes,
      bufferAfterMinutes: bufferMinutes,
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
}
