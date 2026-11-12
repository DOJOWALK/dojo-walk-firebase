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
