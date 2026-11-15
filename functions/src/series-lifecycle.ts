import { Firestore, DocumentReference, Timestamp } from 'firebase-admin/firestore';
import { HttpsError } from 'firebase-functions/v2/https';

export async function setCustomerBookingSeriesStatus(
  db: Firestore,
  args: {
    seriesRef: DocumentReference;
    customerId: string;
    action: 'pause' | 'resume';
  },
): Promise<boolean> {
  const { seriesRef, customerId, action } = args;
  return db.runTransaction(async (tx) => {
    const snapshot = await tx.get(seriesRef);
    if (!snapshot.exists || snapshot.data()?.customerId !== customerId) {
      throw new HttpsError('not-found', 'Recurring schedule was not found.');
    }
    const current = snapshot.data()?.status ?? 'draft';
    if (action === 'pause') {
      if (current === 'paused') return false;
      if (!['draft', 'active'].includes(current)) {
        throw new HttpsError('failed-precondition', 'This recurring schedule can no longer be paused.');
      }
      tx.update(seriesRef, { status: 'paused', updatedAt: Timestamp.now() });
      return true;
    }
    if (current === 'active') return false;
    if (current !== 'paused') {
      throw new HttpsError('failed-precondition', 'Only a paused recurring schedule can be resumed.');
    }
    tx.update(seriesRef, { status: 'active', updatedAt: Timestamp.now() });
    return true;
  });
}
