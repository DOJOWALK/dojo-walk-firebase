const test = require('node:test');
const assert = require('node:assert/strict');
const { resolveWalkerBookingTransition } = require('../lib/walker-lifecycle.js');

const minute = 60 * 1000;
const schedule = {
  scheduledAtMillis: 10 * 60 * minute,
  endsAtMillis: 11 * 60 * minute,
};

test('start is allowed from 30 minutes before schedule through 2 hours after planned end', () => {
  for (const nowMillis of [
    schedule.scheduledAtMillis - 30 * minute,
    schedule.scheduledAtMillis,
    schedule.endsAtMillis + 2 * 60 * minute,
  ]) {
    assert.deepEqual(resolveWalkerBookingTransition({
      action: 'start', bookingStatus: 'confirmed', ...schedule,
      startedAtMillis: null, nowMillis,
    }), { ok: true, status: 'in_progress' });
  }
});

test('start rejects wrong status and times outside the allowed window', () => {
  assert.deepEqual(resolveWalkerBookingTransition({
    action: 'start', bookingStatus: 'draft', ...schedule,
    startedAtMillis: null, nowMillis: schedule.scheduledAtMillis,
  }), { ok: false, reason: 'not_confirmed' });
  for (const nowMillis of [
    schedule.scheduledAtMillis - 30 * minute - 1,
    schedule.endsAtMillis + 2 * 60 * minute + 1,
  ]) {
    assert.deepEqual(resolveWalkerBookingTransition({
      action: 'start', bookingStatus: 'confirmed', ...schedule,
      startedAtMillis: null, nowMillis,
    }), { ok: false, reason: 'outside_start_window' });
  }
});

test('completion requires an in-progress booking and a start timestamp', () => {
  assert.deepEqual(resolveWalkerBookingTransition({
    action: 'complete', bookingStatus: 'confirmed', ...schedule,
    startedAtMillis: 0, nowMillis: 10 * minute,
  }), { ok: false, reason: 'not_in_progress' });
  assert.deepEqual(resolveWalkerBookingTransition({
    action: 'complete', bookingStatus: 'in_progress', ...schedule,
    startedAtMillis: null, nowMillis: 10 * minute,
  }), { ok: false, reason: 'missing_started_at' });
});

test('completion is blocked before five minutes and allowed at five minutes', () => {
  const startedAtMillis = 1000;
  for (const [nowMillis, expected] of [
    [startedAtMillis + 5 * minute - 1, { ok: false, reason: 'too_early_to_complete' }],
    [startedAtMillis + 5 * minute, { ok: true, status: 'completed' }],
  ]) {
    assert.deepEqual(resolveWalkerBookingTransition({
      action: 'complete', bookingStatus: 'in_progress', ...schedule,
      startedAtMillis, nowMillis,
    }), expected);
  }
});
