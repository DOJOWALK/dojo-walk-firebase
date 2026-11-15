export type WalkerBookingAction = 'start' | 'complete';

export type WalkerBookingTransitionFailure =
  | 'not_confirmed'
  | 'outside_start_window'
  | 'not_in_progress'
  | 'missing_started_at'
  | 'too_early_to_complete';

export type WalkerBookingTransitionResult =
  | { ok: true; status: 'in_progress' | 'completed' }
  | { ok: false; reason: WalkerBookingTransitionFailure };

export function resolveWalkerBookingTransition(input: {
  action: WalkerBookingAction;
  bookingStatus: string;
  scheduledAtMillis: number;
  endsAtMillis: number;
  startedAtMillis: number | null;
  nowMillis: number;
}): WalkerBookingTransitionResult {
  if (input.action === 'start') {
    if (input.bookingStatus !== 'confirmed') {
      return { ok: false, reason: 'not_confirmed' };
    }
    const earliest = input.scheduledAtMillis - 30 * 60 * 1000;
    const latest = input.endsAtMillis + 2 * 60 * 60 * 1000;
    if (input.nowMillis < earliest || input.nowMillis > latest) {
      return { ok: false, reason: 'outside_start_window' };
    }
    return { ok: true, status: 'in_progress' };
  }

  if (input.bookingStatus !== 'in_progress') {
    return { ok: false, reason: 'not_in_progress' };
  }
  if (input.startedAtMillis === null) {
    return { ok: false, reason: 'missing_started_at' };
  }
  if (input.nowMillis < input.startedAtMillis + 5 * 60 * 1000) {
    return { ok: false, reason: 'too_early_to_complete' };
  }
  return { ok: true, status: 'completed' };
}
