const test = require('node:test');
const assert = require('node:assert/strict');
const { recurringLocalDateTimeToDate } = require('../lib/schedule');

test('converts Asia/Kolkata morning local time to the correct UTC instant', () => {
  assert.equal(
    recurringLocalDateTimeToDate('2026-11-16', '07:30').toISOString(),
    '2026-11-16T02:00:00.000Z',
  );
});

test('converts dates that cross into the previous UTC day', () => {
  assert.equal(
    recurringLocalDateTimeToDate('2026-11-16', '01:15').toISOString(),
    '2026-11-15T19:45:00.000Z',
  );
});

test('handles leap day correctly', () => {
  assert.equal(
    recurringLocalDateTimeToDate('2028-02-29', '23:59').toISOString(),
    '2028-02-29T18:29:00.000Z',
  );
});

test('rejects impossible calendar dates and malformed date/time values', () => {
  for (const [date, time] of [
    ['2027-02-29', '10:00'],
    ['2026-04-31', '10:00'],
    ['2026-13-01', '10:00'],
    ['2026-11-16', '24:00'],
    ['2026-11-16', '12:60'],
    ['16-11-2026', '12:00'],
    ['2026-11-16', '9:00'],
  ]) {
    assert.throws(() => recurringLocalDateTimeToDate(date, time), (error) =>
      error && error.code === 'invalid-argument');
  }
});
