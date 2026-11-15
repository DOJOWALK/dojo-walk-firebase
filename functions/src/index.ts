import { initializeApp } from 'firebase-admin/app';
import { getFirestore, Timestamp, DocumentReference, DocumentSnapshot } from 'firebase-admin/firestore';
import { onCall, onRequest, HttpsError } from 'firebase-functions/v2/https';
import { defineSecret } from 'firebase-functions/params';
import { createHash } from 'node:crypto';
import { hmacHex, safeHexEqual } from './security';
import { recurringLocalDateTimeToDate } from './schedule';

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

