const test = require('node:test');
const assert = require('node:assert/strict');
const {
  createRecurringOccurrenceBookingId,
  createRecurringRequestFingerprint,
  createRecurringSeriesId,
} = require('../lib/recurring-identity');

const request = {
  durationMinutes: 30,
  address: 'Tower A, Gaur City 2',
  petName: 'Milo',
  city: 'Ghaziabad',
  pincode: '201009',
  startDate: '2026-11-16',
  endDate: '2026-11-30',
  weekdays: [1, 3, 5],
  timeSlots: [{ id: 'morning', localTime: '07:00' }],
  allowBackupWalker: false,
  timezone: 'Asia/Kolkata',
};

test('same customer and idempotency key always produce the same series ID', () => {
  const first = createRecurringSeriesId('customer-1', 'request-key-001');
  const retry = createRecurringSeriesId('customer-1', 'request-key-001');
  assert.equal(first, retry);
  assert.match(first, /^[a-f0-9]{40}$/);
});

test('series IDs are isolated by customer and idempotency key', () => {
  const expected = createRecurringSeriesId('customer-1', 'request-key-001');
  assert.notEqual(createRecurringSeriesId('customer-2', 'request-key-001'), expected);
  assert.notEqual(createRecurringSeriesId('customer-1', 'request-key-002'), expected);
});

test('each local date and slot receives a stable, distinct occurrence booking ID', () => {
  const first = createRecurringOccurrenceBookingId(
    'customer-1', 'request-key-001', '2026-11-16', 'morning',
  );
  const retry = createRecurringOccurrenceBookingId(
    'customer-1', 'request-key-001', '2026-11-16', 'morning',
  );
  const nextDate = createRecurringOccurrenceBookingId(
    'customer-1', 'request-key-001', '2026-11-17', 'morning',
  );
  const nextSlot = createRecurringOccurrenceBookingId(
    'customer-1', 'request-key-001', '2026-11-16', 'evening',
  );
  assert.equal(first, retry);
  assert.notEqual(first, nextDate);
  assert.notEqual(first, nextSlot);
  assert.match(first, /^[a-f0-9]{40}$/);
});

test('weekday selection order does not change the request fingerprint', () => {
  assert.equal(
    createRecurringRequestFingerprint(request),
    createRecurringRequestFingerprint({ ...request, weekdays: [5, 1, 3] }),
  );
});

test('changing a material schedule or consent detail changes the request fingerprint', () => {
  const fingerprint = createRecurringRequestFingerprint(request);
  assert.notEqual(
    createRecurringRequestFingerprint({ ...request, endDate: '2026-12-01' }),
    fingerprint,
  );
  assert.notEqual(
    createRecurringRequestFingerprint({ ...request, allowBackupWalker: true }),
    fingerprint,
  );
  assert.notEqual(
    createRecurringRequestFingerprint({
      ...request,
      timeSlots: [{ id: 'morning', localTime: '08:00' }],
    }),
    fingerprint,
  );
});
