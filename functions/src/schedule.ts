import { HttpsError } from 'firebase-functions/v2/https';

/**
 * Convert a validated Asia/Kolkata wall-clock date/time into an absolute Date.
 * India has no daylight-saving transitions, so the offset is always UTC+05:30.
 */
export function recurringLocalDateTimeToDate(localDate: string, localTime: string): Date {
  const dateMatch = /^(\d{4})-(\d{2})-(\d{2})$/.exec(localDate);
  const timeMatch = /^(\d{2}):(\d{2})$/.exec(localTime);
  if (!dateMatch || !timeMatch) {
    throw new HttpsError('invalid-argument', 'Use YYYY-MM-DD dates and HH:mm local times.');
  }
  const year = Number(dateMatch[1]);
  const month = Number(dateMatch[2]);
  const day = Number(dateMatch[3]);
  const hour = Number(timeMatch[1]);
  const minute = Number(timeMatch[2]);
  const calendarCheck = new Date(Date.UTC(year, month - 1, day));
  if (calendarCheck.getUTCFullYear() !== year
      || calendarCheck.getUTCMonth() !== month - 1
      || calendarCheck.getUTCDate() !== day
      || hour > 23 || minute > 59) {
    throw new HttpsError('invalid-argument', 'A recurring date or local time is invalid.');
  }
  return new Date(Date.UTC(year, month - 1, day, hour, minute) - (330 * 60 * 1000));
}
