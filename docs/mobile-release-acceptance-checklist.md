# DOJO WALK Mobile Release Acceptance Checklist

**Status:** Draft test plan — execution evidence must be recorded by a human tester.  
**Scope:** Customer Flutter app, Walker Flutter app, and existing Firebase callable booking lifecycle.  
**Environment:** Staging or approved test environment only. Do not use real customer/pet data or production payment credentials.

## 1. Entry criteria and test setup

- [ ] Install the exact Customer and Walker Android builds intended for acceptance.
- [ ] Record app version, build number, Git commit SHA, Android version, device model, and test date.
- [ ] Confirm the Firebase project is the approved staging/test project.
- [ ] Prepare separate test Customer and Walker accounts; Walker must be approved and eligible for assignment.
- [ ] Prepare one test booking with a known scheduled start and planned end time.
- [ ] Confirm backend callable deployment/version matches the tested app branch.
- [ ] Use test phone numbers and sandbox payment credentials only.
- [ ] Confirm a tester can inspect backend booking state and callable logs without exposing secrets in screenshots or reports.

**Evidence rule:** For each case record Pass / Fail / Blocked, tester, timestamp, build SHA, and redacted evidence. A CI result is not evidence that a real device flow passed.

## 2. Customer app — authentication and booking

| ID | Test | Expected result |
|---|---|---|
| C-01 | Request OTP using a valid test phone number | OTP request succeeds and the app gives clear feedback. |
| C-02 | Submit a valid OTP | Customer reaches the authenticated app and correct account. |
| C-03 | Submit an invalid or expired OTP | Authentication is rejected with a useful message; no authenticated session is created. |
| C-04 | Close and reopen the app after successful login | Session restoration behaves as designed; no account mix-up. |
| C-05 | Create a one-time booking using valid service details | Booking is created once and confirmation/status is consistent with backend state. |
| C-06 | Tap booking submission repeatedly or retry after a slow response | No unintended duplicate booking is created. |
| C-07 | Open booking history | Upcoming bookings appear before past bookings; missing/invalid dates do not crash or incorrectly lead the list. |
| C-08 | Inspect booking/payment status chips and displayed amount | Labels and amount match backend values; unknown values remain safe/readable. |
| C-09 | Open booking details after a network interruption | Clear retry/error behavior; no misleading success state. |

## 3. Customer app — recurring schedule lifecycle

| ID | Test | Expected result |
|---|---|---|
| R-01 | Create or open an eligible recurring schedule | Schedule details and occurrences render with correct local date/time ordering. |
| R-02 | Pause an active or draft schedule and confirm | pauseCustomerBookingSeries is called with the expected seriesId; schedule becomes paused after backend success. |
| R-03 | Start Pause and dismiss confirmation | No callable mutation occurs. |
| R-04 | Resume a paused schedule and confirm | resumeCustomerBookingSeries is called with the expected seriesId; refreshed state shows resumed status. |
| R-05 | Attempt pause/resume when backend state no longer permits the transition | Backend rejects the transition; UI shows an actionable error and refreshes state. |
| R-06 | Sign in as a different Customer and attempt to operate on the first Customer's series | Backend ownership check rejects the request. |
| R-07 | Reload history after pause/resume | Displayed schedule status and occurrence data match backend state. |

## 4. Walker app — assigned bookings and lifecycle

| ID | Test | Expected result |
|---|---|---|
| W-01 | Sign in as an approved test Walker | Only that Walker's authorized dashboard data is shown. |
| W-02 | Open assigned walks | Walks sort by scheduled date/time; missing or invalid dates do not crash the screen. |
| W-03 | Inspect assigned booking details | Status, payment status, quoted amount, scheduled/end/start times, and service address are accurate where available. Customer phone/email are not exposed in the assigned-walk card. |
| W-04 | Open a confirmed booking | Start walk action is available. |
| W-05 | Open an in-progress booking | Complete walk action is visible but disabled until the minimum duration has elapsed. |
| W-06 | Open a completed or cancelled booking | No Start or Complete action is offered. |
| W-07 | Start a confirmed booking within the permitted backend time window | updateWalkerBookingStatus succeeds with the expected booking ID/action and backend records the start. |
| W-08 | Attempt to start outside the permitted window | Backend rejects the action and the UI communicates the failure without showing a false success. |
| W-09 | Attempt completion before five minutes from backend-recorded startedAt | UI keeps Complete disabled; a direct callable attempt is rejected by backend. |
| W-10 | Keep the in-progress screen open until five minutes have elapsed | The 15-second UI refresh eventually enables Complete without requiring manual reload. |
| W-11 | Complete at or after the five-minute threshold | Callable succeeds only if all backend state/time checks pass; UI refreshes to completed state. |
| W-12 | Try to start a completed booking again | No restart action is available; backend remains authoritative and rejects invalid transitions. |
| W-13 | Sign in as a different/unassigned Walker and attempt a booking action | Backend assignment/authorization checks reject the action. |

**Timing constraints to verify against the deployed backend:** Walker start is permitted only from 30 minutes before scheduled start through 2 hours after planned end. Completion requires the booking to be in progress and at least 5 minutes to have elapsed since startedAt. Backend checks remain authoritative; client-side button state is not a security boundary.

## 5. Resilience, privacy, and device checks

- [ ] Repeat key flows on at least one supported physical Android device, not only an emulator.
- [ ] Test slow, interrupted, and restored network connectivity during OTP, booking, pause/resume, start, and completion.
- [ ] Confirm loading indicators prevent accidental duplicate actions.
- [ ] Confirm errors do not leave stale success states or silently discard backend failures.
- [ ] Verify date/time display against the intended service timezone and device timezone changes.
- [ ] Verify app background/resume and process restart during an in-progress booking.
- [ ] Confirm sensitive customer contact details are not unnecessarily displayed or logged.
- [ ] Confirm no location tracking/background location permission was introduced as part of this scope.
- [ ] Check Android permissions, notification behavior (if applicable), accessibility/readability, and small-screen layouts.
- [ ] Confirm release APK installs and launches on the target Android versions.

## 6. Release blockers and sign-off

Do not mark mobile release acceptance complete while any of the following remain:

- Any P0/P1 issue in authentication, booking creation, booking ownership, Walker assignment, or booking lifecycle.
- Customer or Walker UI reports success while the backend mutation failed.
- Duplicate booking or duplicate lifecycle mutation can be produced by retries.
- Walker can complete before the backend minimum duration or act on an unassigned booking.
- Customer can pause/resume another Customer's recurring schedule.
- Sensitive customer data is exposed beyond the approved UI/access model.
- Physical-device installation or core booking lifecycle testing has not been completed.
- Required operational handover, emergency escalation, or support processes for the launch scope remain unapproved.

### Test execution record

| Field | Value |
|---|---|
| Test environment / Firebase project | Pending |
| Customer build version + SHA | Pending |
| Walker build version + SHA | Pending |
| Android device(s) / OS version(s) | Pending |
| Tester / execution date | Pending |
| P0/P1 defects | Pending |
| Customer acceptance | Not run |
| Walker acceptance | Not run |
| Backend/log verification | Not run |
| Release decision | **Not approved — manual acceptance outstanding** |

## 7. Current automated evidence (not device acceptance)

- Customer app: latest recorded CI passed for commit eb4c12d6568e353a96cd352bd9af939eac659fba.
- Walker app: CI passed for commit 598e716505463854d5f847731545c53345905f3a, including unit tests, Flutter Analyze, Android release APK build, and artifact upload.
- Firebase backend: latest recorded CI passed for commit 933ecf23aa0279ccef7b9b77ee81d065e84c8544, including rules/emulator and recurring lifecycle checks.
- These results validate the recorded CI runs only. Re-check each repository's current PR head and latest CI before a release decision.

**Governance:** This checklist is documentation only. It does not authorize production deployment, release publication, collection of new sensitive data, or changes to emergency-contact/incident workflows.
