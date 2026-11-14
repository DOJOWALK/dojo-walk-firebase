# Recurring booking and walk-job model

## Status

The backend now has an initial draft-only callable, `createRecurringBookingSeries`, that expands a selected schedule into a series document and individual booking drafts. It supports the initial `Asia/Kolkata` timezone, up to 31 calendar days and 30 occurrences, one or two distinct daily slots, and deterministic idempotency. It records candidate availability windows, not confirmed capacity. No walker is held, no payment is collected, and no series is confirmed. Do not expose recurring controls in the customer app until the full lifecycle below is implemented and tested end to end.

## Core model

A recurring plan is a customer service agreement, not a reservation that blocks a walker for the entire month.

- `bookingSeries/{seriesId}` stores the customer's recurring instructions: owner ID, dog/profile reference, service address and verified service area, duration, local timezone, selected weekdays, selected time slots, effective start/end dates, billing preference, backup-walker consent, and lifecycle status.
- `bookings/{bookingId}` remains the canonical individual walk occurrence. Every occurrence has one `seriesId`, `occurrenceKey`, local service date/time, UTC `scheduledAt`, `endsAt`, its own quote snapshot, its own assignment/reservation, payment state, and walk report.
- Morning and evening selections create separate occurrence documents. A package or monthly invoice references the series and its included occurrences; it is never a single month-long walker reservation.
- One-time bookings continue to use the existing booking flow with no `seriesId`.

## Creation contract

A future callable (proposed name: `createRecurringBookingSeries`) must:

1. Require an authenticated customer and validate all fields server-side.
2. Accept an explicit IANA timezone (for the initial launch, normally `Asia/Kolkata`); never interpret a date-only value using the server timezone.
3. Accept selected weekdays and explicit time slots. Reject an empty selection, invalid dates, past occurrences, unsupported duration, excessive horizon, or an occurrence count over the configured safety cap.
4. Expand the requested date range into deterministic occurrence keys (series ID + local date + slot ID). Repeated calls must be idempotent and must not create duplicate occurrences.
5. Snapshot the active server-side pricing configuration for each occurrence. The current callable snapshots the configured amount per occurrence. Admin price changes affect future quotes only; accepted occurrence quotes remain immutable.
6. Create occurrence drafts only after validation. Do not claim the whole series is confirmed merely because drafts exist.
7. Return per-occurrence results and clearly identify dates/times where no availability window candidate was found. A candidate is not a confirmed capacity slot: reservation transactions must recheck live overlap and eligibility. A partial schedule must be shown as partial; never silently drop failed occurrences.
8. Require the owner to review and accept the occurrence-level total before any payment is collected. The server must calculate the total from occurrence quote snapshots; the client must not submit a trusted amount.
9. Do not create one long reservation or assign one walker for the entire series.

## Assignment and capacity

Each occurrence must independently pass the existing service-area, walker eligibility, availability-window, and reservation-overlap checks. Reuse the transactional reservation logic for each individual occurrence.

- Keep the existing Primary Walker first for each repeat occurrence when available.
- A different walker is considered only when the customer explicitly opted in to backup substitution for the series/occurrence.
- If the primary is unavailable and backup consent is off, mark that occurrence as needing customer action; do not silently substitute.
- A series can have multiple walkers across dates if that is what the customer consented to and actual capacity permits.
- Enforce travel/rest buffers in the overlap predicate before launch. A simple time-overlap check alone is not sufficient for geographically separated walks.
- Recheck eligibility and availability inside the transaction that creates each hold. Precomputed candidate lists are discovery hints only.
- A failed occurrence must not undo already paid/confirmed independent occurrences unless the customer-facing series terms explicitly define an all-or-nothing policy.

## Payment and billing

The current Razorpay flow is booking-scoped: one order and captured payment are reconciled against one booking quote and one walker hold. Do not attach one Razorpay order to multiple booking IDs by merely changing client payloads.

Before enabling series checkout, choose and implement one auditable billing model:

- **Per-occurrence payment:** each walk uses the existing booking payment flow; simplest initial pilot and clearest refund accounting.
- **Series invoice:** create a server-owned invoice with immutable line items referencing occurrence IDs and quote snapshots; payment reconciliation must atomically record invoice payment and allocate it to those occurrences. Handle partial refunds and cancellations explicitly.

Until one model is implemented, recurring series should be a schedule request / draft only and should not imply paid or confirmed service.

## Lifecycle and admin operations

Suggested series states: `draft`, `review_required`, `active`, `paused`, `completed`, `cancelled`.

Occurrence booking states continue to be managed individually (draft, walker-held, payment pending, confirmed, in progress, completed, cancelled, payment review). Series state must never overwrite occurrence payment or walk state.

Admin tools must support:
- viewing a series with its occurrence calendar and per-occurrence status;
- replacing or cancelling one occurrence without rewriting the whole series;
- pausing/resuming future generation;
- reviewing failed/unassigned occurrences and customer consent;
- changing future price rules without mutating existing quote snapshots;
- audit logging for every admin intervention.

## Current implementation boundary

The current callable requires a client-generated idempotency key and rejects reuse of that key with different schedule details. It validates real calendar dates, selected weekdays, unique slot IDs/times, and ensures two daily slots are separated by at least the requested walk duration. It creates at most 31 writes (one series plus 30 occurrence drafts) in a single transaction. Candidate availability is only a pre-screen based on configured availability windows; it does not query reservation conflicts and must never be presented as a confirmed slot.

## Safe rollout

1. Add automated tests for timezone-safe occurrence expansion and deterministic idempotency keys.
2. Add server-side series and occurrence creation with a strict horizon/count cap; no walker holds or payment in this first slice.
3. Add customer review of the exact occurrence list and total, plus per-occurrence availability results.
4. Add one-at-a-time reservation and explicit backup-consent handling for each occurrence.
5. Launch per-occurrence payment for the Crossings Republik pilot; only later consider consolidated series invoicing.
6. Add admin series/occurrence management and cancellation/refund tooling before enabling recurring bookings to all customers.

## Required tests before customer rollout

- Weekday expansion across month boundaries, leap day, and daylight-saving timezone boundaries.
- Morning and evening slots produce distinct jobs.
- Duplicate/retried requests create no duplicate occurrences.
- Occurrence cap and date horizon are enforced server-side.
- Disabled/unconfigured pricing blocks quote creation; every occurrence stores an immutable quote snapshot.
- Admin price edits do not change existing occurrence quotes.
- One unavailable occurrence does not create a false whole-series confirmation.
- Primary walker continuity and backup consent are enforced independently per occurrence.
- Concurrent requests cannot create overlapping holds for the same walker.
- Payment success, late capture, duplicate capture, cancellation, and refund are reconciled per occurrence or via a separately tested invoice ledger.
- Firestore rules deny client writes to series, bookings, invoices, reservations, and audit records.
