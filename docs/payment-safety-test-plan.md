# Payment safety test plan

This checklist is a release gate for the Razorpay + Firestore booking flow. It is a test plan, not evidence that these scenarios have already passed.

## Environment prerequisites

- Use a separate Firebase project with Firestore, Authentication, and Functions Emulator or a dedicated staging project.
- Use Razorpay Test Mode credentials and a webhook endpoint configured with a separate test webhook secret.
- Seed only synthetic customers, walkers, bookings, reservations, and admin pricing.
- Never put live Razorpay secrets or service-account credentials in source control or CI logs.
- Confirm the deployed Functions secret bindings include `RAZORPAY_KEY_ID`, `RAZORPAY_KEY_SECRET`, and `RAZORPAY_WEBHOOK_SECRET`.

## Checkout and order creation

| Scenario | Expected result |
| --- | --- |
| Unauthenticated customer creates/verifies an order | Rejected |
| Customer requests another customer's booking | Not found / permission denied |
| Booking is not in `walker_held` state | Order creation rejected |
| Walker hold or reservation has expired | Order creation rejected |
| Quote has expired or amount/currency differs from stored quote | Order creation rejected |
| Booking's walker or reservation changes between initial read and lock transaction | Lock rejected; no Razorpay order created |
| Two concurrent order-creation requests | At most one order-creation lock and one Razorpay order |
| Razorpay API outcome is uncertain | Booking moves to `reconciliation_required`; retry does not create another order |
| Razorpay returns a different amount/currency/status | Booking remains blocked for reconciliation |

## Checkout verification and webhook

| Scenario | Expected result |
| --- | --- |
| Invalid checkout HMAC signature | Rejected; booking remains unpaid |
| Valid signature but payment is not captured | Not confirmed |
| Payment order ID, amount, or currency does not match booking snapshot | Not confirmed; support review if capture exists |
| Valid captured payment and valid reservation hold | Booking and reservation confirmed atomically |
| Captured payment after reservation becomes invalid | Booking moves to `payment_review`; never silently assigned |
| Same captured payment verified repeatedly | Idempotent; no duplicate payment record |
| Payment ID already linked to another booking | Rejected and surfaced for investigation |
| Webhook has invalid/missing signature or malformed JSON | HTTP 400; no database state change |
| Valid non-capture webhook event | Acknowledged and ignored |
| Duplicate webhook event delivery | Acknowledged without duplicate processing |
| Two concurrent deliveries for same captured payment | One effective payment finalization; duplicate delivery safely acknowledged/retried |
| Valid captured webhook for an unknown order | No booking is confirmed; alert/reconciliation process required |

## Cancellation, quote refresh, and hold cleanup

- Cancellation is allowed only for eligible unpaid drafts/holds.
- Cancellation is blocked while order creation is in progress, an order exists, or reconciliation is required.
- Quote refresh is blocked after order creation begins or payment identifiers exist.
- Expired-hold cleanup must not release/reassign a booking with a creating/created/reconciliation-required order or a payment identifier.
- After payment capture, customer cancellation must follow the admin-configured refund/support workflow; it must not erase payment evidence.

## Release evidence required

- Automated emulator tests for transaction races, authorization, idempotency, and state transitions.
- Razorpay Test Mode evidence for successful capture, failed/uncaptured payment, duplicate webhook, invalid signature, and uncertain order-creation recovery.
- A tested admin reconciliation procedure for `reconciliation_required`, duplicate capture, and `payment_review`.
- A verified rollback/backup procedure before production deployment.

## Current automated coverage

The CI suite now includes:

- Unit tests for checkout HMAC and exact webhook raw-body HMAC validation.
- Pure payment-decision tests for matching captures, mismatches, duplicate captures, and invalid/expired holds.
- Firestore Emulator transaction tests against the production payment-finalizer function: valid hold confirmation, expired-hold payment review, same-payment idempotency, concurrent duplicate finalization, and payment-ID collision.
- Firestore security-rules Emulator tests.

Still not covered by these emulator tests:

- End-to-end reservation candidate selection and concurrent walker-overlap contention.
- Live Razorpay Test Mode checkout, webhook signature delivery, API timeouts, and reconciliation recovery.
- Concurrent webhook event-document claim semantics.

A passing CI run is evidence only for the automated cases above, not a completed payment certification. Do not deploy on the basis of this checklist alone.
