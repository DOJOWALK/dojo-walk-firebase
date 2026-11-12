# Booking serviceability data model

The callable `createBookingDraft` fails closed. It requires a verified service-area pincode and at least one active walker whose availability window contains the entire requested walk.

## Firestore documents

### `serviceAreas/{cityId}/pincodes/{pincode}`

Create this document only after the operations team verifies the exact pincode and its city.

```json
{
  "city": "Ghaziabad",
  "enabled": true,
  "verifiedAt": "<Firestore Timestamp>",
  "walkerIds": ["<walker uid>"]
}
```

Supported city IDs: `noida`, `greater-noida`, `ghaziabad`. The document ID is the six-digit pincode. `walkerIds` is an operations-managed allowlist, not client input.

### `walkers/{walkerUid}`

```json
{
  "active": true,
  "serviceablePincodes": ["<six-digit pincode>"]
}
```

A walker must be active and list the requested pincode. Keep this list aligned with the pincode's `walkerIds`.

### `walkers/{walkerUid}/availabilityWindows/{windowId}`

```json
{
  "status": "available",
  "startAt": "<Firestore Timestamp>",
  "endAt": "<Firestore Timestamp>"
}
```

A window qualifies only when `startAt <= requestedStart` and `endAt >= requestedEnd`. Store timestamps, not date strings. Add the composite index in `firestore.indexes.json`.

## Important operational safeguards

- Do not create placeholder/guessed pincode documents. Until verified coverage and availability data exist, booking drafts are rejected.
- The callable stores eligible walker IDs for later assignment, but it does **not** reserve a walker. Two customers could pass the same availability check concurrently.
- Before taking payment, implement a transactional/lease-based walker hold, final assignment, expiry/release, and idempotent payment order/webhook flow.
- Keep these collections writable only by trusted server/admin operations. The existing Firestore catch-all deny rule blocks client writes.
- Configure verified pin codes and real walker windows before describing any neighborhood as live or accepting paid bookings.

## Transactional walker hold

After a customer creates a draft, the authenticated app may call `reserveWalkerForBooking` with its booking ID.

- The callable checks booking ownership and draft status on the server.
- It rechecks the walker's active flag, pincode and full-interval availability window.
- It checks for overlapping held (unexpired) or confirmed reservations.
- It writes a 10-minute hold and changes the booking status to `walker_held` in one Firestore transaction.
- Every reservation transaction also updates the walker's shared reservation-version field. This creates a transaction conflict between simultaneous attempts against the same walker, so overlapping holds cannot both commit.
- If a hold expires, the next reservation attempt for that booking marks the old hold expired and returns the booking to draft before retrying.
- The customer can call `releaseWalkerHold` with the booking ID to release their own active hold.

Reservation documents live at `walkers/{walkerUid}/reservations/{reservationId}` and include `bookingId`, `customerId`, `startAt`, `endAt`, `status`, `expiresAt`, and `createdAt`.

## Payment gateway boundary

The current backend deliberately does not create payment orders or mark bookings paid. Before implementation, the business must select a payment provider (for example Razorpay, Cashfree, or PayU) and configure its server-side credentials in Firebase Secret Manager. The production flow must create the provider order server-side for the exact server-calculated amount, verify the signed provider webhook, enforce idempotency, and atomically convert a valid hold into a confirmed booking. Never trust a client payment-success callback or client-supplied amount.

