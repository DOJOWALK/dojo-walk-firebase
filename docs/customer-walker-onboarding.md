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

1. **Login:** enter an Indian mobile number and verify it with OTP.
2. **Profile:** collect customer name; email remains optional.
3. **Address:** collect the service address, supported city, and six-digit pincode; confirm serviceability.
4. **Pet details:** collect pet name and only the care/behaviour/emergency details needed to deliver the walk safely.
5. **Consent:** accept Terms & Conditions and acknowledge the Privacy, cancellation, refund, and grievance policies.
6. **Booking:** choose 30/45/60-minute duration, view configured price and serviceability, then see assignment and booking status.
7. **Payment:** keep payment as a separate later stage; do not change Razorpay order, checkout verification, or webhook implementation in this onboarding work.

A normal Customer account does not require Aadhaar, PAN, bank account, or selfie/face KYC for ordinary dog-walking booking. Request additional verification only where a documented legal or specific safety need exists, with notice and an appropriate alternative.

Customer profile should contain only the minimum operational fields: UID, verified phone, display name, optional email, createdAt, updatedAt, and profile-completion state. Address and pet information should be collected in the booking flow and stored with the booking, not exposed publicly.

## Walker journey (approved product flow)

The Walker must complete all onboarding stages before the operational Dashboard is unlocked:

1. **Login:** enter an Indian mobile number and verify it with Firebase Phone OTP.
2. **Selfie verification:** capture a live selfie, obtain explicit consent, and complete the configured face-match/liveness check. A profile photo alone is not identity verification.
3. **KYC:** complete the approved identity and payout checks:
   - Aadhaar verification through a lawful UIDAI-compliant method, with a non-Aadhaar alternative where required or appropriate.
   - PAN verification where required for tax/payout compliance.
   - Bank account verification, including account-holder name matching and a controlled penny-drop/provider check where selected.
4. **Training:** complete and pass DOJO WALK training covering dog handling, animal welfare, leash and street safety, customer conduct, incident reporting, and emergency response. Record module version, completion time, and result.
5. **Admin approval:** an authorized Admin reviews the application, verification outcomes, and training result. Record reviewer UID, decision, timestamp, and reason.
6. **Dashboard unlock:** only after all required checks pass and Admin approval is recorded may the Walker enter the operational Dashboard and accept work.

The operational Dashboard must not contain a KYC collection workflow or ask the Walker to complete KYC after entering it. Incomplete/rejected applicants see only a restricted onboarding/status screen, not booking or availability actions.

Police verification is not part of the default onboarding checklist. Add it only if a documented legal requirement, insurance condition, or approved risk policy for the relevant operating location requires it; never represent it as a universal government requirement without confirming the applicable rule.

Walker application must remain inactive and unable to set availability, receive reservations, or start/complete walks until selfie/face verification, required KYC, training, and authorized Admin approval are all complete.

## Walker verification and privacy

- A profile photo and a live selfie are different. The live selfie step must use a genuine liveness/face-verification process; do not label a simple upload as verified.
- Before face capture, show a clear notice explaining purpose, provider, retention, access, and how to request help or exercise applicable rights. Obtain the required consent.
- Aadhaar must be handled only through a lawful UIDAI-compliant verification route. Do not force Aadhaar authentication where the law requires a choice or an alternative. Do not retain Aadhaar biometrics.
- PAN and bank checks must use a trusted provider or other lawful verification method. Do not store internet-banking passwords, card PINs, OTPs, or UPI PINs.
- Prefer storing verification outcome, timestamp, provider reference, and masked identifiers instead of full Aadhaar/PAN/bank details.
- If document images are genuinely required, use private Cloud Storage paths scoped to applicant UID, strict Storage Rules, short-lived access for authorized reviewers, audit logs, encryption at rest, and a defined deletion schedule.
- Never expose document URLs, full ID numbers, bank account numbers, face templates, or raw provider payloads in Customer app, public Walker profile, logs, analytics, or ordinary Admin lists.
- Keep selfie/face data separate from the ordinary profile photo; define access, retention, deletion, and incident-response controls before production collection.
- Police/background verification is not a default product requirement. Add it only after confirming a specific applicable legal/contractual requirement and an authorized verification process.
- Do not enable live KYC collection until the provider/process, consent language, legal basis, access controls, retention/deletion policy, and failure/review path have been approved.

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
