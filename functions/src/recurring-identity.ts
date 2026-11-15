import { createHash } from 'node:crypto';

export interface RecurringRequestFingerprintInput {
  durationMinutes: number;
  address: string;
  petName: string;
  city: string;
  pincode: string;
  startDate: string;
  endDate: string;
  weekdays: number[];
  timeSlots: Array<{id: string; localTime: string}>;
  allowBackupWalker: boolean;
  timezone: string;
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

export function createRecurringSeriesId(customerId: string, idempotencyKey: string): string {
  return sha256(customerId + ':' + idempotencyKey).slice(0, 40);
}

export function createRecurringOccurrenceBookingId(
  customerId: string,
  idempotencyKey: string,
  localDate: string,
  slotId: string,
): string {
  return sha256(customerId + ':' + idempotencyKey + ':' + localDate + '_' + slotId).slice(0, 40);
}

export function createRecurringRequestFingerprint(
  input: RecurringRequestFingerprintInput,
): string {
  return sha256(JSON.stringify({
    ...input,
    weekdays: [...input.weekdays].sort((a, b) => a - b),
    timeSlots: [...input.timeSlots].sort((a, b) =>
      a.localTime.localeCompare(b.localTime) || a.id.localeCompare(b.id)),
  }));
}
