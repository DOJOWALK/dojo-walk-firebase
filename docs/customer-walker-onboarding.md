# DOJO WALK Customer and Walker Onboarding

## Product goal

Provide a low-friction, Zomato/Swiggy-style onboarding experience while keeping identity, role creation, document review, and booking permissions server-controlled.

Launch cities: Noida, Greater Noida, and Ghaziabad. Serviceability is decided by the admin-enabled six-digit pincode list, not by city name alone.

## Shared identity rules

- Mobile OTP is the primary authentication method for Customer and Walker.
- Email is optional for both roles; if supplied, it must be valid and unique to the Firebase Auth identity.
- One verified phone number maps to one Firebase Auth UID.
- The same UID may have one Customer profile and one Walker profile.
- A role profile is keyed by UID: `customers/{uid}` or `walkers/{uid}`; never create a second UID merely to add the other role.
- Existing email/password accounts must first authenticate and link a verified phone credential to the same UID. Never silently migrate by creating a fresh UID.
- If a phone is already linked to another UID, stop and require secure account recovery. Do not auto-merge on typed phone/email.
- Public registration must never create an Admin role. Admin remains protected by the existing server-issued `admin: true` custom claim.

## Customer journey

1. Welcome screen: Continue with mobile number.
2. Phone entry: accept Indian mobile number, normalize to E.164, explain that an OTP will be sent.
3. OTP verification: resend cooldown, attempt throttling, clear error and expired-code states.
4. Profile setup: display name and optional email. Do not ask for the phone again after it is verified.
5. Service address: choose supported city, enter six-digit pincode, address details, and pet name.
6. Home: show booking durations (30/45/60 minutes), configured price, and serviceability feedback.
7. Booking: show assignment and booking status timeline. Payment remains a separate later stage.

Customer profile should contain only the minimum operational fields: UID, verified phone, display name, optional email, createdAt, updatedAt, and profile-completion state. Address and pet information should be collected in the booking flow and stored with the booking, not exposed publicly.

## Walker journey

1. Welcome screen: Join as a Walker / Sign in.
2. Phone OTP verification.
3. Basic profile: legal/display name, profile photo, optional email, city, home pincode, and serviceable area request.
4. Safety and document step: show the purpose of each requested check, obtain explicit consent, and collect only what the approved verification process needs.
5. Review screen: applicant sees what was submitted and that account status is Pending.
6. Admin review: approve/reject with an auditable reviewer UID and timestamp.
7. Approved dashboard: availability, assigned walks, and walk status actions.

Walker application must remain inactive and unable to set availability, receive reservations, or start/complete walks until an authorized Admin approves it.

## Walker verification and privacy

- Profile photo is a basic profile field, not proof of identity.
- Aadhaar or other government ID should be requested only after the business has selected a lawful, secure verification process and published a clear privacy notice and retention period.
- Prefer a verified result/status and a restricted provider reference over storing a full Aadhaar number or unnecessary document copies.
- If a document image must be stored, use private Cloud Storage paths scoped to the applicant UID, strict Storage Rules, short-lived access for authorized reviewers, audit logs, encryption at rest, and a defined deletion schedule.
- Never expose document URLs, full ID numbers, or raw verification payloads in Customer app, public Walker profile, logs, analytics, or ordinary admin lists.
- Police/background verification status should be represented as a restricted status and verification timestamp/provider reference. Do not claim a check is complete unless a trusted process confirms it.
- Do not make Aadhaar or police verification a hard blocker until the verification vendor/process, consent language, legal basis, access controls, and retention/deletion policy are ready.

## Server-side security requirements

- Derive UID and verified phone from Firebase Auth token; never trust a phone number supplied only in request data.
- After OTP migration is enabled, Walker application submission must require `request.auth.token.phone_number` to match the submitted/normalized phone. Keep a compatibility phase for existing accounts until migration is complete.
- Customer and Walker profile creation must be idempotent per UID and reject duplicate role profiles.
- Profile updates must use field allowlists; clients cannot set role, active, approved, admin, reviewedBy, or verification status.
- Only Admin custom-claim callables may approve/reject a Walker, enable service areas, or change privileged statuses.
- Keep Firestore and Storage client writes denied for protected booking, reservation, approval, and verification data; use validated callable functions.
- Apply OTP abuse protection, callable rate limits, App Check where supported, and generic authentication errors that do not reveal whether a phone/email is registered.
- Keep payment order creation, checkout verification, and webhook behavior out of this onboarding work.

## Acceptance checks

- A new phone user can create one Customer profile and later one Walker profile using the same UID.
- Repeating registration in the same role routes to sign-in/profile recovery and does not create another profile.
- Existing email/password account can link a verified phone and retains the same UID and all prior data.
- Phone already linked to a different UID causes a safe stop, not an automatic merge.
- Unverified or mismatched phone cannot submit a Walker application after migration enforcement is enabled.
- Pending/rejected Walker cannot access approved-only dashboard actions or receive a booking.
- Only a user with the server-issued Admin custom claim can review Walker applications.
- Customer cannot read Walker verification documents or another Customer's profile/address.
- Tests cover OTP invalid/expired/retry behavior, duplicate role creation, unauthorized approval, and document access denial.

## Delivery order

1. Complete OTP-first authentication and legacy account linking in Customer and Walker.
2. Add Customer profile bootstrap and Walker application profile completion.
3. Add secure document verification only after the storage/consent/retention design is ready.
4. Extend Admin review to show safe verification statuses, not raw sensitive documents.
5. Build and run automated tests for all affected repositories.
6. Perform one consolidated device test after the major flows are complete.
7. Keep Razorpay order, checkout verification, and webhook changes deferred.
