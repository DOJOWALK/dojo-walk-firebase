
import { initializeApp } from 'firebase-admin/app';
import { getFirestore, Timestamp } from 'firebase-admin/firestore';
import {
  onCall,
  HttpsError,
  type CallableRequest,
} from 'firebase-functions/v2/https';

initializeApp();

const db = getFirestore();

const allowedDurations = new Set([30, 45, 60]);

const walkerCityConfig = new Map([
  ['Noida', 'noida'],
  ['Greater Noida', 'greater-noida'],
  ['Ghaziabad', 'ghaziabad'],
]);

type CallHandler = (request: CallableRequest<any>) => Promise<any>;

const callable = (handler: CallHandler) => onCall(handler);
const callableMumbai = (handler: CallHandler) =>
  onCall({ region: 'asia-south1' }, handler);

function requireAuth(request: CallableRequest<any>) {
  if (!request.auth) {
    throw new HttpsError('unauthenticated', 'Please sign in first.');
  }
  return request.auth;
}

function requireAdmin(request: CallableRequest<any>) {
  const auth = requireAuth(request);
  if (auth.token.admin !== true) {
    throw new HttpsError('permission-denied', 'Admin access is required.');
  }
  return auth;
}

function validBookingId(value: unknown): value is string {
  return typeof value === 'string'
    && /^[A-Za-z0-9]{1,128}$/.test(value);
}

function toIso(value: unknown): string | null {
  return value instanceof Timestamp
    ? value.toDate().toISOString()
    : null;
}

// ---------------------------------------------------------
// CUSTOMER ACCOUNT
// ---------------------------------------------------------

const getCustomerAccountHandler: CallHandler = async (request) => {
  const auth = requireAuth(request);
  const ref = db.collection('customers').doc(auth.uid);
  const snap = await ref.get();

  if (!snap.exists) {
    return {
      exists: false,
      uid: auth.uid,
      displayName: '',
      phone: auth.token.phone_number ?? '',
      email: auth.token.email ?? '',
    };
  }

  const data = snap.data()!;

  return {
    exists: true,
    uid: auth.uid,
    displayName: data.displayName ?? '',
    phone: data.phone ?? auth.token.phone_number ?? '',
    email: data.email ?? auth.token.email ?? '',
  };
};

export const getCustomerAccount = callable(getCustomerAccountHandler);

const saveCustomerAccountHandler: CallHandler = async (request) => {
  const auth = requireAuth(request);
  const data = request.data ?? {};

  const displayName = typeof data.displayName === 'string'
    ? data.displayName.trim()
    : '';

  if (displayName.length < 2 || displayName.length > 80) {
    throw new HttpsError(
      'invalid-argument',
      'Name must be between 2 and 80 characters.',
    );
  }

  const verifiedPhone = typeof auth.token.phone_number === 'string'
    ? auth.token.phone_number
    : '';

  const ref = db.collection('customers').doc(auth.uid);
  const now = Timestamp.now();

  await ref.set({
    displayName,
    phone: verifiedPhone,
    email: auth.token.email ?? null,
    updatedAt: now,
    createdAt: data.createdAt ?? now,
  }, { merge: true });

  return {
    success: true,
    uid: auth.uid,
    displayName,
    phone: verifiedPhone,
  };
};

export const saveCustomerAccount = callable(saveCustomerAccountHandler);

// ---------------------------------------------------------
// CUSTOMER BOOKING
// No payment, no walker availability check, no reservation.
// Booking becomes confirmed after valid details are submitted.
// ---------------------------------------------------------

const createBookingDraftHandler: CallHandler = async (request) => {
  const auth = requireAuth(request);
  const data = request.data ?? {};

  const {
    durationMinutes,
    scheduledAt,
    address,
    petName,
    city,
    pincode,
    requestId,
  } = data;

  if (typeof requestId !== 'string'
      || !/^[a-f0-9]{32}$/.test(requestId)) {
    throw new HttpsError(
      'invalid-argument',
      'A valid booking request ID is required.',
    );
  }

  if (!Number.isInteger(durationMinutes)
      || !allowedDurations.has(durationMinutes)) {
    throw new HttpsError(
      'invalid-argument',
      'Duration must be 30, 45, or 60 minutes.',
    );
  }

  if (typeof city !== 'string' || !walkerCityConfig.has(city)) {
    throw new HttpsError(
      'invalid-argument',
      'Choose Noida, Greater Noida, or Ghaziabad.',
    );
  }

  if (typeof pincode !== 'string' || !/^\d{6}$/.test(pincode)) {
    throw new HttpsError(
      'invalid-argument',
      'Enter a valid 6-digit pincode.',
    );
  }

  if (typeof address !== 'string'
      || !address.trim()
      || address.trim().length > 500) {
    throw new HttpsError(
      'invalid-argument',
      'Enter an address up to 500 characters.',
    );
  }

  if (typeof petName !== 'string'
      || !petName.trim()
      || petName.trim().length > 80) {
    throw new HttpsError(
      'invalid-argument',
      'Enter a pet name up to 80 characters.',
    );
  }

  if (typeof scheduledAt !== 'string') {
    throw new HttpsError(
      'invalid-argument',
      'A valid scheduled date and time are required.',
    );
  }

  const start = new Date(scheduledAt);

  if (Number.isNaN(start.getTime()) || start.getTime() <= Date.now()) {
    throw new HttpsError(
      'invalid-argument',
      'Choose a valid future walk time.',
    );
  }

  const normalized = {
    city,
    pincode,
    durationMinutes,
    address: address.trim(),
    petName: petName.trim(),
    scheduledAt: start.toISOString(),
  };
  const fingerprint = JSON.stringify(normalized);

  const requestRef = db.collection('customers')
    .doc(auth.uid)
    .collection('bookingRequests')
    .doc(requestId);
  const bookingRef = db.collection('bookings').doc();
  const startTimestamp = Timestamp.fromDate(start);
  const endTimestamp = Timestamp.fromDate(
    new Date(start.getTime() + durationMinutes * 60 * 1000),
  );

  const bookingId = await db.runTransaction(async (tx) => {
    const requestSnap = await tx.get(requestRef);

    if (requestSnap.exists) {
      const saved = requestSnap.data()!;
      if (saved.fingerprint !== fingerprint
          || typeof saved.bookingId !== 'string') {
        throw new HttpsError(
          'failed-precondition',
          'This request ID is already linked to different booking details.',
        );
      }
      return saved.bookingId;
    }

    const now = Timestamp.now();
    tx.create(bookingRef, {
      customerId: auth.uid,
      city,
      pincode,
      durationMinutes,
      address: address.trim(),
      petName: petName.trim(),
      scheduledAt: startTimestamp,
      endsAt: endTimestamp,
      // Admin will assign a walker later.
      walkerId: null,
      assignedAt: null,
      assignedBy: null,
      status: 'confirmed',
      confirmedAt: now,
      createdAt: now,
      updatedAt: now,
    });

    tx.create(requestRef, {
      bookingId: bookingRef.id,
      fingerprint,
      createdAt: now,
    });

    return bookingRef.id;
  });

  return {
    bookingId,
    status: 'confirmed',
    message: 'Your booking is confirmed.',
  };
};

export const createBookingDraft = callable(createBookingDraftHandler);

// Mumbai-region endpoint used by the customer app.
export const createBookingDraftMumbai =
  callableMumbai(createBookingDraftHandler);

// ---------------------------------------------------------
// CUSTOMER BOOKING HISTORY
// ---------------------------------------------------------

const getCustomerBookingsHandler: CallHandler = async (request) => {
  const auth = requireAuth(request);

  const snap = await db.collection('bookings')
    .where('customerId', '==', auth.uid)
    .orderBy('createdAt', 'desc')
    .limit(50)
    .get();

  const walkerIds = [...new Set(
    snap.docs
      .map((doc) => doc.data().walkerId)
      .filter((id): id is string => typeof id === 'string' && id.length > 0),
  )];

  const walkerSnapshots = await Promise.all(
    walkerIds.map((walkerId) => db.collection('walkers').doc(walkerId).get()),
  );
  const walkerNames = new Map(
    walkerSnapshots.map((walkerSnap) => [
      walkerSnap.id,
      walkerSnap.exists ? walkerSnap.data()?.displayName ?? '' : '',
    ]),
  );

  return {
    bookings: snap.docs.map((doc) => {
      const data = doc.data();
      const walkerId = typeof data.walkerId === 'string'
        ? data.walkerId
        : null;

      return {
        bookingId: doc.id,
        petName: data.petName ?? '',
        city: data.city ?? '',
        pincode: data.pincode ?? '',
        address: data.address ?? '',
        durationMinutes: data.durationMinutes ?? 0,
        scheduledAt: toIso(data.scheduledAt),
        endsAt: toIso(data.endsAt),
        status: data.status ?? 'unknown',
        walkerId,
        walkerName: walkerId ? walkerNames.get(walkerId) ?? '' : null,
        assignedAt: toIso(data.assignedAt),
        createdAt: toIso(data.createdAt),
      };
    }),
  };
};

export const getCustomerBookings =
  callable(getCustomerBookingsHandler);

// ---------------------------------------------------------
// CUSTOMER CANCELLATION
// Customer can cancel only before Admin assigns a walker.
// ---------------------------------------------------------

const cancelCustomerBookingHandler: CallHandler = async (request) => {
  const auth = requireAuth(request);
  const bookingId = request.data?.bookingId;

  if (!validBookingId(bookingId)) {
    throw new HttpsError(
      'invalid-argument',
      'A valid booking ID is required.',
    );
  }

  const bookingRef = db.collection('bookings').doc(bookingId);
  const now = Timestamp.now();

  await db.runTransaction(async (tx) => {
    const snap = await tx.get(bookingRef);

    if (!snap.exists || snap.data()?.customerId !== auth.uid) {
      throw new HttpsError('not-found', 'Booking was not found.');
    }

    const booking = snap.data()!;

    if (booking.status !== 'confirmed'
        || typeof booking.walkerId === 'string') {
      throw new HttpsError(
        'failed-precondition',
        'This booking cannot be cancelled in the app. Please contact support.',
      );
    }

    if (!(booking.scheduledAt instanceof Timestamp)
        || booking.scheduledAt.toMillis() <= now.toMillis()) {
      throw new HttpsError(
        'failed-precondition',
        'A past or started booking cannot be cancelled.',
      );
    }

    tx.update(bookingRef, {
      status: 'cancelled',
      cancelledAt: now,
      updatedAt: now,
    });
  });

  return {
    bookingId,
    status: 'cancelled',
  };
};

export const cancelCustomerBooking =
  callable(cancelCustomerBookingHandler);

// ---------------------------------------------------------
// ADMIN BOOKING LIST
// ---------------------------------------------------------

const listAdminBookingsHandler: CallHandler = async (request) => {
  requireAdmin(request);

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
        petName: data.petName ?? '',
        city: data.city ?? '',
        pincode: data.pincode ?? '',
        address: data.address ?? '',
        durationMinutes: data.durationMinutes ?? 0,
        scheduledAt: toIso(data.scheduledAt),
        endsAt: toIso(data.endsAt),
        status: data.status ?? 'unknown',
        createdAt: toIso(data.createdAt),
      };
    }),
  };
};

export const listAdminBookings =
  callable(listAdminBookingsHandler);

// ---------------------------------------------------------
// ADMIN ASSIGNS WALKER
// No availability or reservation check.
// Walker must be approved, active and match booking location.
// ---------------------------------------------------------

const assignWalkerToBookingHandler: CallHandler = async (request) => {
  const admin = requireAdmin(request);

  const bookingId = request.data?.bookingId;
  const walkerId = request.data?.walkerId;

  if (!validBookingId(bookingId)
      || typeof walkerId !== 'string'
      || !/^[A-Za-z0-9_-]{1,128}$/.test(walkerId)) {
    throw new HttpsError(
      'invalid-argument',
      'A valid booking ID and walker ID are required.',
    );
  }

  const bookingRef = db.collection('bookings').doc(bookingId);
  const walkerRef = db.collection('walkers').doc(walkerId);
  const now = Timestamp.now();

  await db.runTransaction(async (tx) => {
    const [bookingSnap, walkerSnap] = await Promise.all([
      tx.get(bookingRef),
      tx.get(walkerRef),
    ]);

    if (!bookingSnap.exists) {
      throw new HttpsError('not-found', 'Booking was not found.');
    }

    if (!walkerSnap.exists) {
      throw new HttpsError('not-found', 'Walker was not found.');
    }

    const booking = bookingSnap.data()!;
    const walker = walkerSnap.data()!;

    if (booking.status !== 'confirmed'
        || typeof booking.walkerId === 'string') {
      throw new HttpsError(
        'failed-precondition',
        'This booking is not available for walker assignment.',
      );
    }

    if (walker.active !== true
        || walker.applicationStatus !== 'approved') {
      throw new HttpsError(
        'failed-precondition',
        'Only approved and active walkers can be assigned.',
      );
    }

    const walkerCity = walker.applicationCity;
    const walkerPincode = walker.applicationPincode;

    const matchesLocation = walkerCity === booking.city
      && (
        walkerPincode === booking.pincode
        || (
          Array.isArray(walker.serviceablePincodes)
          && walker.serviceablePincodes.includes(booking.pincode)
        )
      );

    if (!matchesLocation) {
      throw new HttpsError(
        'failed-precondition',
        'Walker city or pincode does not match this booking.',
      );
    }

    tx.update(bookingRef, {
      walkerId,
      assignedAt: now,
      assignedBy: admin.uid,
      updatedAt: now,
    });
  });

  return {
    bookingId,
    walkerId,
    status: 'confirmed',
    assigned: true,
  };
};

export const assignWalkerToBooking =
  callable(assignWalkerToBookingHandler);

// ---------------------------------------------------------
// WALKER APPLICATION
// ---------------------------------------------------------

const submitWalkerApplicationHandler: CallHandler = async (request) => {
  const auth = requireAuth(request);
  const data = request.data ?? {};

  const displayName = typeof data.displayName === 'string'
    ? data.displayName.trim()
    : '';

  const phone = typeof data.phone === 'string'
    ? data.phone.replace(/\D/g, '')
    : '';

  const verifiedPhone = typeof auth.token.phone_number === 'string'
    ? auth.token.phone_number.replace(/\D/g, '').slice(-10)
    : '';

  if (verifiedPhone && verifiedPhone !== phone) {
    throw new HttpsError(
      'permission-denied',
      'Application phone must match your verified sign-in number.',
    );
  }

  const city = typeof data.city === 'string' ? data.city : '';
  const pincode = typeof data.pincode === 'string'
    ? data.pincode.trim()
    : '';

  if (displayName.length < 2 || displayName.length > 80) {
    throw new HttpsError(
      'invalid-argument',
      'Enter your name (2 to 80 characters).',
    );
  }

  if (!/^[6-9]\d{9}$/.test(phone)) {
    throw new HttpsError(
      'invalid-argument',
      'Enter a valid 10-digit Indian mobile number.',
    );
  }

  if (!walkerCityConfig.has(city)) {
    throw new HttpsError(
      'invalid-argument',
      'Choose Noida, Greater Noida, or Ghaziabad.',
    );
  }

  if (!/^\d{6}$/.test(pincode)) {
    throw new HttpsError(
      'invalid-argument',
      'Enter a valid 6-digit pincode.',
    );
  }

  const ref = db.collection('walkers').doc(auth.uid);
  const existing = await ref.get();

  if (existing.exists && existing.data()?.active === true) {
    throw new HttpsError(
      'already-exists',
      'This walker account is already approved.',
    );
  }

  const now = Timestamp.now();

  await ref.set({
    displayName,
    email: auth.token.email ?? null,
    phone,
    applicationCity: city,
    applicationPincode: pincode,
    applicationStatus: 'pending',
    active: false,
    serviceablePincodes: [],
    updatedAt: now,
    ...(!existing.exists ? { createdAt: now } : {}),
  }, { merge: true });

  return {
    status: 'pending',
    message: 'Your application was submitted for admin review.',
  };
};

export const submitWalkerApplication =
  callable(submitWalkerApplicationHandler);

export const submitWalkerApplicationMumbai =
  callableMumbai(submitWalkerApplicationHandler);

// ---------------------------------------------------------
// GET WALKER APPLICATION
// ---------------------------------------------------------

const getWalkerApplicationHandler: CallHandler = async (request) => {
  const auth = requireAuth(request);

  const snap = await db.collection('walkers').doc(auth.uid).get();

  if (!snap.exists) {
    return {
      exists: false,
      status: 'not_submitted',
    };
  }

  const data = snap.data()!;

  return {
    exists: true,
    status: data.applicationStatus
      ?? (data.active === true ? 'approved' : 'pending'),
    displayName: data.displayName ?? '',
    phone: data.phone ?? '',
    city: data.applicationCity ?? '',
    pincode: data.applicationPincode ?? '',
    active: data.active === true,
  };
};

export const getWalkerApplication =
  callable(getWalkerApplicationHandler);

export const getWalkerApplicationMumbai =
  callableMumbai(getWalkerApplicationHandler);

// ---------------------------------------------------------
// WALKER AVAILABILITY
// Retained for walker app information.
// Booking and admin assignment do NOT check these windows.
// ---------------------------------------------------------

const saveWalkerAvailabilityHandler: CallHandler = async (request) => {
  const auth = requireAuth(request);
  const uid = auth.uid;

  const walkerRef = db.collection('walkers').doc(uid);
  const walkerSnap = await walkerRef.get();

  if (!walkerSnap.exists
      || walkerSnap.data()?.active !== true
      || walkerSnap.data()?.applicationStatus !== 'approved') {
    throw new HttpsError(
      'permission-denied',
      'Only approved active walkers can update availability.',
    );
  }

  const rawWindows = request.data?.windows;

  if (!Array.isArray(rawWindows) || rawWindows.length > 14) {
    throw new HttpsError(
      'invalid-argument',
      'Submit up to 14 availability windows at a time.',
    );
  }

  const parsed = rawWindows.map((item: any) => {
    if (!item
        || typeof item.startAt !== 'string'
        || typeof item.endAt !== 'string') {
      throw new HttpsError(
        'invalid-argument',
        'Each window needs start and end times.',
      );
    }

    const start = new Date(item.startAt);
    const end = new Date(item.endAt);

    if (Number.isNaN(start.getTime())
        || Number.isNaN(end.getTime())
        || start.getTime() <= Date.now()
        || end.getTime() <= start.getTime()
        || end.getTime() - start.getTime() > 16 * 60 * 60 * 1000) {
      throw new HttpsError(
        'invalid-argument',
        'Availability must be a future window no longer than 16 hours.',
      );
    }

    return { start, end };
  }).sort((a, b) => a.start.getTime() - b.start.getTime());

  for (let i = 1; i < parsed.length; i++) {
    if (parsed[i].start.getTime() < parsed[i - 1].end.getTime()) {
      throw new HttpsError(
        'invalid-argument',
        'Availability windows cannot overlap.',
      );
    }
  }

  const windowsRef = walkerRef.collection('availabilityWindows');

  const existing = await windowsRef
    .where('status', '==', 'available')
    .where('endAt', '>', Timestamp.now())
    .limit(400)
    .get();

  const conflicts = existing.docs.some((doc) => {
    const data = doc.data();

    if (!(data.startAt instanceof Timestamp)
        || !(data.endAt instanceof Timestamp)) {
      return false;
    }

    return parsed.some(({ start, end }) =>
      start.getTime() < data.endAt.toMillis()
      && end.getTime() > data.startAt.toMillis(),
    );
  });

  if (conflicts) {
    throw new HttpsError(
      'already-exists',
      'This time overlaps with availability already saved.',
    );
  }

  const batch = db.batch();

  parsed.forEach(({ start, end }) => {
    const ref = windowsRef.doc();

    batch.set(ref, {
      startAt: Timestamp.fromDate(start),
      endAt: Timestamp.fromDate(end),
      status: 'available',
      createdAt: Timestamp.now(),
      updatedAt: Timestamp.now(),
    });
  });

  await batch.commit();

  return { saved: parsed.length };
};

export const saveWalkerAvailability =
  callable(saveWalkerAvailabilityHandler);

export const saveWalkerAvailabilityMumbai =
  callableMumbai(saveWalkerAvailabilityHandler);

// ---------------------------------------------------------
// WALKER START / COMPLETE BOOKING
// ---------------------------------------------------------

const updateWalkerBookingStatusHandler: CallHandler = async (request) => {
  const auth = requireAuth(request);
  const uid = auth.uid;

  const bookingId = request.data?.bookingId;
  const action = request.data?.action;

  if (!validBookingId(bookingId)
      || !['start', 'complete'].includes(action)) {
    throw new HttpsError(
      'invalid-argument',
      'A valid booking ID and walk action are required.',
    );
  }

  const walkerRef = db.collection('walkers').doc(uid);
  const bookingRef = db.collection('bookings').doc(bookingId);
  const now = Timestamp.now();

  const result = await db.runTransaction(async (tx) => {
    const [walkerSnap, bookingSnap] = await Promise.all([
      tx.get(walkerRef),
      tx.get(bookingRef),
    ]);

    if (!walkerSnap.exists
        || walkerSnap.data()?.active !== true
        || walkerSnap.data()?.applicationStatus !== 'approved') {
      throw new HttpsError(
        'permission-denied',
        'Only approved active walkers can update walks.',
      );
    }

    if (!bookingSnap.exists
        || bookingSnap.data()?.walkerId !== uid) {
      throw new HttpsError(
        'not-found',
        'This walk is not assigned to your account.',
      );
    }

    const booking = bookingSnap.data()!;

    if (!(booking.scheduledAt instanceof Timestamp)
        || !(booking.endsAt instanceof Timestamp)) {
      throw new HttpsError(
        'failed-precondition',
        'Booking schedule details are invalid.',
      );
    }

    if (action === 'start') {
      if (booking.status !== 'confirmed') {
        throw new HttpsError(
          'failed-precondition',
          'Only confirmed walks can be started.',
        );
      }

      const earliest = booking.scheduledAt.toMillis()
        - 30 * 60 * 1000;

      const latest = booking.endsAt.toMillis()
        + 2 * 60 * 60 * 1000;

      if (now.toMillis() < earliest || now.toMillis() > latest) {
        throw new HttpsError(
          'failed-precondition',
          'Walk can be started from 30 minutes before its scheduled time until 2 hours after its planned end.',
        );
      }

      tx.update(bookingRef, {
        status: 'in_progress',
        startedAt: now,
        updatedAt: now,
      });

      return 'in_progress';
    }

    if (booking.status !== 'in_progress'
        || !(booking.startedAt instanceof Timestamp)) {
      throw new HttpsError(
        'failed-precondition',
        'Only an in-progress walk can be completed.',
      );
    }

    if (now.toMillis()
        < booking.startedAt.toMillis() + 5 * 60 * 1000) {
      throw new HttpsError(
        'failed-precondition',
        'A walk must be in progress for at least 5 minutes before completion.',
      );
    }

    tx.update(bookingRef, {
      status: 'completed',
      completedAt: now,
      updatedAt: now,
    });

    return 'completed';
  });

  return {
    bookingId,
    status: result,
  };
};

export const updateWalkerBookingStatus =
  callable(updateWalkerBookingStatusHandler);

export const updateWalkerBookingStatusMumbai =
  callableMumbai(updateWalkerBookingStatusHandler);

// ---------------------------------------------------------
// WALKER DASHBOARD
// Only bookings assigned by Admin appear here.
// ---------------------------------------------------------

const getWalkerDashboardHandler: CallHandler = async (request) => {
  const auth = requireAuth(request);
  const uid = auth.uid;

  const walkerSnap = await db.collection('walkers').doc(uid).get();

  if (!walkerSnap.exists
      || walkerSnap.data()?.active !== true
      || walkerSnap.data()?.applicationStatus !== 'approved') {
    throw new HttpsError(
      'permission-denied',
      'Walker account is not approved and active.',
    );
  }

  const now = Timestamp.now();

  const [upcomingSnap, activeSnap, windowsSnap] = await Promise.all([
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

    db.collection('walkers').doc(uid)
      .collection('availabilityWindows')
      .where('status', '==', 'available')
      .where('endAt', '>', now)
      .orderBy('startAt', 'asc')
      .limit(50)
      .get(),
  ]);

  const bookingDocs = [...activeSnap.docs, ...upcomingSnap.docs];

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
        scheduledAt: toIso(data.scheduledAt),
        endsAt: toIso(data.endsAt),
        status: data.status ?? 'confirmed',
        startedAt: toIso(data.startedAt),
      };
    }),

    availability: windowsSnap.docs.map((doc) => {
      const data = doc.data();

      return {
        windowId: doc.id,
        startAt: toIso(data.startAt),
        endAt: toIso(data.endAt),
      };
    }),
  };
};

export const getWalkerDashboard =
  callable(getWalkerDashboardHandler);

export const getWalkerDashboardMumbai =
  callableMumbai(getWalkerDashboardHandler);

// ---------------------------------------------------------
// ADMIN WALKER APPLICATIONS
// ---------------------------------------------------------

const listPendingWalkerApplicationsHandler: CallHandler = async (request) => {
  requireAdmin(request);

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
        createdAt: toIso(data.createdAt),
      };
    }),
  };
};

export const listPendingWalkerApplications =
  callable(listPendingWalkerApplicationsHandler);

const reviewWalkerApplicationHandler: CallHandler = async (request) => {
  const admin = requireAdmin(request);

  const walkerId = request.data?.walkerId;
  const decision = request.data?.decision;

  if (typeof walkerId !== 'string'
      || !/^[A-Za-z0-9_-]{1,128}$/.test(walkerId)
      || !['approve', 'reject'].includes(decision)) {
    throw new HttpsError(
      'invalid-argument',
      'A valid walker ID and review decision are required.',
    );
  }

  const walkerRef = db.collection('walkers').doc(walkerId);
  const walkerSnap = await walkerRef.get();

  if (!walkerSnap.exists
      || walkerSnap.data()?.applicationStatus !== 'pending') {
    throw new HttpsError(
      'not-found',
      'Pending walker application was not found.',
    );
  }

  const application = walkerSnap.data()!;
  const now = Timestamp.now();

  if (decision === 'reject') {
    await walkerRef.update({
      applicationStatus: 'rejected',
      active: false,
      reviewedAt: now,
      reviewedBy: admin.uid,
      updatedAt: now,
    });

    return { walkerId, status: 'rejected' };
  }

  const city = application.applicationCity;
  const pincode = application.applicationPincode;

  const cityId = typeof city === 'string'
    ? walkerCityConfig.get(city)
    : undefined;

  if (!cityId || typeof pincode !== 'string'
      || !/^\d{6}$/.test(pincode)) {
    throw new HttpsError(
      'failed-precondition',
      'Walker application has invalid city or pincode data.',
    );
  }

  const coverageRef = db.doc(
    `serviceAreas/${cityId}/pincodes/${pincode}`,
  );

  await db.runTransaction(async (tx) => {
    const [freshWalker, coverageSnap] = await Promise.all([
      tx.get(walkerRef),
      tx.get(coverageRef),
    ]);

    if (!freshWalker.exists
        || freshWalker.data()?.applicationStatus !== 'pending') {
      throw new HttpsError(
        'failed-precondition',
        'This application has already been reviewed.',
      );
    }

    const coverage = coverageSnap.data();

    if (!coverageSnap.exists
        || coverage?.enabled !== true
        || coverage.city !== city) {
      throw new HttpsError(
        'failed-precondition',
        'Admin must enable this pincode before approving this walker.',
      );
    }

    const walkerIds = Array.isArray(coverage.walkerIds)
      ? coverage.walkerIds.filter(
          (id: unknown): id is string => typeof id === 'string',
        )
      : [];

    if (!walkerIds.includes(walkerId)) {
      walkerIds.push(walkerId);
    }

    tx.update(walkerRef, {
      applicationStatus: 'approved',
      active: true,
      serviceablePincodes: [pincode],
      reviewedAt: now,
      reviewedBy: admin.uid,
      updatedAt: now,
    });

    tx.set(coverageRef, {
      walkerIds,
      updatedAt: now,
    }, { merge: true });
  });

  return {
    walkerId,
    status: 'approved',
    pincode,
  };
};

export const reviewWalkerApplication =
  callable(reviewWalkerApplicationHandler);

// ---------------------------------------------------------
// BOOKING PRICING
// Retained for displaying prices in the app.
// Pricing is NOT required to confirm a booking.
// ---------------------------------------------------------

const getBookingPricingHandler: CallHandler = async (request) => {
  requireAuth(request);

  const durations = ['30', '45', '60'] as const;

  const snapshots = await Promise.all(
    durations.map((duration) =>
      db.collection('bookingPricing').doc(duration).get(),
    ),
  );

  return Object.fromEntries(
    durations.map((duration, index) => {
      const data = snapshots[index].data();

      const amountPaise =
        Number.isSafeInteger(data?.amountPaise)
        && data!.amountPaise >= 0
          ? data!.amountPaise
          : 0;

      return [duration, {
        amountPaise,
        amountRupees: amountPaise / 100,
        active: data?.active === true && amountPaise > 0,
        currency: 'INR',
      }];
    }),
  );
};

export const getBookingPricing =
  callable(getBookingPricingHandler);

const setBookingPricingHandler: CallHandler = async (request) => {
  const admin = requireAdmin(request);

  const duration = request.data?.duration;
  const amountRupees = request.data?.amountRupees;

  if (!['30', '45', '60'].includes(duration)
      || typeof amountRupees !== 'number'
      || !Number.isFinite(amountRupees)
      || amountRupees < 0
      || amountRupees > 100000
      || Math.abs(
        amountRupees * 100 - Math.round(amountRupees * 100),
      ) > 1e-7) {
    throw new HttpsError(
      'invalid-argument',
      'Enter a valid non-negative price in rupees.',
    );
  }

  const amountPaise = Math.round(amountRupees * 100);
  const now = Timestamp.now();

  await db.collection('bookingPricing').doc(duration).set({
    durationMinutes: Number(duration),
    amountPaise,
    currency: 'INR',
    active: amountPaise > 0,
    updatedAt: now,
    updatedBy: admin.uid,
  }, { merge: true });

  return {
    duration,
    amountRupees,
    amountPaise,
    active: amountPaise > 0,
  };
};

export const setBookingPricing =
  callable(setBookingPricingHandler);

// ---------------------------------------------------------
// ADMIN SERVICE AREAS
// Retained for walker onboarding and service-area management.
// Booking confirmation does not check this configuration.
// ---------------------------------------------------------

const getAdminServiceAreasHandler: CallHandler = async (request) => {
  requireAdmin(request);

  const cityEntries = [...walkerCityConfig.entries()];

  const areas = await Promise.all(
    cityEntries.map(async ([city, cityId]) => {
      const snapshot = await db.collection('serviceAreas')
        .doc(cityId)
        .collection('pincodes')
        .get();

      return snapshot.docs.map((doc) => ({
        city,
        pincode: doc.id,
        enabled: doc.data().enabled === true,
        walkerCount: Array.isArray(doc.data().walkerIds)
          ? doc.data().walkerIds.length
          : 0,
      }));
    }),
  );

  return {
    areas: areas.flat().sort(
      (a, b) =>
        a.city.localeCompare(b.city)
        || a.pincode.localeCompare(b.pincode),
    ),
  };
};

export const getAdminServiceAreas =
  callable(getAdminServiceAreasHandler);

const setAdminServiceAreaHandler: CallHandler = async (request) => {
  const admin = requireAdmin(request);

  const city = request.data?.city;
  const pincode = request.data?.pincode;
  const enabled = request.data?.enabled;

  const cityId = typeof city === 'string'
    ? walkerCityConfig.get(city)
    : undefined;

  if (!cityId
      || typeof pincode !== 'string'
      || !/^\d{6}$/.test(pincode)
      || typeof enabled !== 'boolean') {
    throw new HttpsError(
      'invalid-argument',
      'Choose a supported city, valid pincode and enabled state.',
    );
  }

  const ref = db.collection('serviceAreas')
    .doc(cityId)
    .collection('pincodes')
    .doc(pincode);

  await db.runTransaction(async (tx) => {
    const current = await tx.get(ref);
    const existing = current.data() ?? {};

    tx.set(ref, {
      city,
      enabled,
      walkerIds: Array.isArray(existing.walkerIds)
        ? existing.walkerIds
        : [],
      updatedAt: Timestamp.now(),
      updatedBy: admin.uid,
    }, { merge: true });
  });

  return { city, pincode, enabled };
};

export const setAdminServiceArea =
  callable(setAdminServiceAreaHandler);
