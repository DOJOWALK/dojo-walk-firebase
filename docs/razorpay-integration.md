# Razorpay payment integration

DOJO WALK uses Razorpay Orders API with INR amounts. The server is the source of truth for pricing, order creation, payment verification, and booking confirmation.

## Firestore pricing configuration

The callable reads a trusted server-side document:

- `bookingPricing/30`
- `bookingPricing/45`
- `bookingPricing/60`

Missing pricing documents are returned to the admin dashboard as ₹0. New installations therefore start with all three durations at ₹0 / disabled. Each document must be configured by an administrator before that duration can accept payment:

```json
{
  "active": true,
  "amountPaise": 0,
  "currency": "INR",
  "updatedAt": "<Firestore Timestamp>"
}
```

Replace `0` with the actual agreed price in paise before enabling the duration. The Admin Panel writes these documents through admin-only `setBookingPricing`; `getBookingPricing` reads the current values. Prices are entered in rupees in the dashboard and stored as integer paise. Saving ₹0 sets `active: false`. If a document is missing, inactive, zero, or has an invalid amount, order creation fails closed. Do not accept price or amount from the mobile client.

Keep pricing documents writable only by trusted admin/server processes. The existing Firestore catch-all deny rule blocks client writes.

## Firebase Secret Manager

From the Firebase project directory, set these secrets using Razorpay **Test Mode** API keys first:

```bash
firebase functions:secrets:set RAZORPAY_KEY_ID
firebase functions:secrets:set RAZORPAY_KEY_SECRET
firebase functions:secrets:set RAZORPAY_WEBHOOK_SECRET
```

Enter each value only at the secure CLI prompt. Never commit keys, webhook secrets, or credentials to GitHub or the Flutter app. The Key ID is returned by the authenticated order callable for Checkout; the Key Secret and Webhook Secret remain server-only.

Deploy after configuring secrets:

```bash
firebase deploy --only functions
```

The webhook endpoint is:

```
https://us-central1-dojo-platform-b68a3.cloudfunctions.net/razorpayWebhook
```

In the Razorpay Dashboard, configure that URL as a webhook and subscribe to **payment.captured**. Use the exact same webhook secret entered into Firebase Secret Manager. Keep Test Mode and Live Mode webhook configurations/credentials separate.

## End-to-end flow

1. Customer signs in, creates a booking draft, and obtains a transactional walker hold.
2. The authenticated `createRazorpayOrder` callable checks booking ownership, hold state, and server pricing. It creates an INR Razorpay order on the server and stores the order ID/amount against the booking.
3. Flutter opens the official `razorpay_flutter` Checkout using only the returned Key ID, order ID, and amount. No secret is shipped to the device.
4. The Checkout success callback sends payment ID and signature to `verifyRazorpayCheckout`. The server computes HMAC-SHA256 over its stored `order_id|payment_id`, compares in constant time, then fetches the payment from Razorpay and requires captured status, exact order, exact amount and INR currency.
5. Independently, `razorpayWebhook` verifies `X-Razorpay-Signature` against the unmodified raw request body using HMAC-SHA256. It fetches both the payment and order from Razorpay again and requires payment `captured` plus order `paid` before processing.
6. Both paths call the same Firestore transaction. It creates an idempotent payment record, confirms the reservation and booking only if the walker hold is still valid, and sets `paymentStatus: paid`.
7. If Razorpay captured money but the walker hold is no longer valid, the booking becomes `payment_review`. The service must not be dispatched; support must arrange a refund or resolution. An additional capture is flagged for refund review.

## Idempotency and operational safeguards

- Checkout verification and the webhook share a payment document keyed by Razorpay payment ID. Repeated delivery of the same payment does not create another confirmation.
- Webhook event IDs are hashed before use as Firestore document IDs. Duplicate webhook deliveries are acknowledged.
- The order-creation callable uses a Firestore lock. If the network outcome is uncertain after the Razorpay request, it moves the booking to `reconciliation_required` and blocks client retries to avoid creating a second order. A function crash while the lock is `creating` also needs manual reconciliation; support must inspect Razorpay Dashboard before changing the booking.
- A 15-minute payment window is written onto the reservation after order creation. Payment after expiry is not allowed to confirm service automatically.
- Configure Razorpay automatic capture in the Dashboard. The backend only confirms after Razorpay reports `captured`; an authorised-but-uncaptured payment is not a paid booking.
- Do not dispatch a walker based on the mobile callback alone. Only the server-confirmed `bookings/{bookingId}.status == confirmed` and `paymentStatus == paid` qualify.
- Monitor `payment_review`, `reconciliation_required`, and `paymentReviewRequired` records daily. Add an admin refund/reconciliation workflow before public launch.

## Test checklist

1. Configure test secrets and test pricing documents for all enabled durations.
2. Verify missing/inactive pricing blocks order creation.
3. Verify client-supplied amount is ignored (the callable accepts only booking ID).
4. Complete a Razorpay Test Mode payment and verify server-side captured status.
5. Replay the same webhook; it must not create a second confirmation.
6. Send an invalid webhook signature; endpoint must reject it.
7. Try a payment for another customer's booking; callable must reject it.
8. Expire/release the walker hold before capture; booking must go to `payment_review`, not `confirmed`.
9. Verify only a captured INR payment for the exact stored order and amount confirms the booking.

No live credentials, pricing values, webhook registration, deployment, or payment test are included in this repository change.
