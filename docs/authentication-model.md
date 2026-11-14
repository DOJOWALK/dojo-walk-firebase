# DOJO WALK Authentication Model

## Approved product rules

- Mobile number OTP is the primary sign-in method for Customer, Walker, and Admin.
- Email is optional for Customer and Walker profiles.
- An email address, when attached to an identity, must not be attached to a second Firebase Authentication user.
- One verified mobile number maps to one Firebase Authentication UID.
- The same UID may hold separate app roles: Customer, Walker, and (only when explicitly granted) Admin.
- Each role may have at most one profile per UID: `customers/{uid}`, `walkers/{uid}`, and `admins/{uid}`.
- A phone number already used in the Customer app may also be used to create the Walker role, and vice versa. It must not create a second profile in either role.
- Admin role is never self-service. It must be provisioned by an existing trusted admin process and remain protected by the server-side custom claim `admin: true`.

## Identity and role design

Use Firebase Phone Authentication to verify the E.164 mobile number. Firebase Authentication enforces one account per verified phone number. Customer and Walker apps should sign in with the same phone identity; each app then creates or loads only its own role profile using the authenticated UID.

A role profile is not a separate authentication identity. It is a separate application role attached to the same verified identity. This is what permits one person to be both a Customer and a Walker without permitting duplicate Customer or duplicate Walker profiles.

## Legacy account migration

Do not silently create a new phone-auth UID for a person who already has an email/password account. Provide a one-time account-linking flow: the user authenticates to the existing account, completes phone OTP verification, and links the verified phone credential to that existing Firebase UID. Preserve the existing UID so customer bookings, walker applications, reservations, and admin claims remain associated with the original account.

If Firebase reports that the phone is already linked to another UID, stop and require a secure account-recovery/merge process. Never merge accounts based only on a typed phone number or email address.

## Admin enrollment

The current authorized Admin account must be retained. The admin signs in using the existing trusted method for one-time enrollment, verifies their mobile number by OTP, and links it to that same UID. Subsequent Admin sign-in can use phone OTP, but the server must still verify the existing `admin: true` custom claim. Public Customer/Walker registration must never grant Admin.

## Server-side enforcement

- For Walker application submission, require the verified Auth token phone number to match the submitted phone number.
- Customer and Walker role creation must be idempotent per UID.
- Reject role creation if that role profile already exists; route the user to sign-in/profile recovery instead.
- Never trust a phone number supplied only in request data.
- Keep all booking, walker approval, and Admin callable authorization checks bound to `request.auth.uid` and Admin custom claims.
- Do not change Razorpay order creation, checkout verification, or webhook code as part of this authentication work.

## Delivery sequence

1. Implement OTP-first sign-in and one-time legacy account linking in Customer and Walker apps.
2. Add server-side role/verified-phone checks and preserve existing profile document IDs.
3. Add secure OTP enrollment/sign-in for the existing Admin UID without changing its custom claim.
4. Run CI builds and automated checks for all affected repositories.
5. Perform one consolidated end-to-end test with Customer, Walker, and Admin.
6. Keep payment integration deferred until the final stage.
