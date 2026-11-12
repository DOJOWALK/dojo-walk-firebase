# DOJO WALK — Firebase Backend

Firebase Functions, Firestore rules and indexes for the DOJO WALK platform.

## Razorpay

Razorpay integration is implemented in `functions/src/index.ts`:

- `createRazorpayOrder`: authenticated order creation from trusted Firestore pricing.
- `verifyRazorpayCheckout`: server-side Checkout signature and captured-payment verification.
- `razorpayWebhook`: raw-body HMAC webhook verification for `payment.captured`.
- `getBookingPaymentStatus`: authenticated customer status lookup.

Only a server-verified captured payment for the matching paid INR order and a still-valid walker reservation can confirm a booking. Read `docs/razorpay-integration.md` before configuring secrets or deploying.

## Important

- No Razorpay secrets, webhook registration, pricing values, or live payment transaction are stored in this repository.
- Configure Firebase Secret Manager and business-approved Firestore pricing before testing.
- Review `payment_review` and `reconciliation_required` cases. Do not dispatch a walk unless booking status is `confirmed` and payment status is `paid`.
- Run build, emulator, webhook replay, and Test Mode checkout tests before production.
