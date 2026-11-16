# Operational Handover and Emergency Contact — RFC

**Status:** Proposal only; not an implemented data contract.  
**Scope:** Customer, assigned Walker, and authorized Admin during one booking.  
**Decision gate:** Product, operations, privacy, and legal approval is required before schema, callable, rules, or app changes.

## 1. Current implementation constraints

- Booking documents are readable by the booking's customer, assigned walker, and Admin. Do not add sensitive emergency-contact or incident details to the top-level booking document without first narrowing read access.
- Client writes to protected booking data are denied. Any future write must go through an authenticated, validated callable.
- The current booking lifecycle uses `draft`, `walker_held`, `confirmed`, `in_progress`, `completed`, and cancellation states. Safety context must not be exposed to an unassigned candidate walker or after access expires.
- Existing onboarding guidance calls for collecting only care/behaviour/emergency details necessary to deliver a safe walk. It does not define an approved emergency-contact schema or operational escalation process.

## 2. Proposed booking-scoped data boundary

Do not store this information on `customers/{uid}`, `walkers/{uid}`, or the public Walker profile. Keep it booking-scoped and separate from the ordinary booking document.

Proposed private path (not yet created):

```
bookings/{bookingId}/privateSafety/context
```

Candidate fields, subject to approval:

| Field | Purpose | Handling |
|---|---|---|
| `emergencyContact.name` | Person to contact if the customer cannot be reached | Optional; customer supplied |
| `emergencyContact.relationship` | Context for the contact | Optional |
| `emergencyContact.phoneE164` | Emergency contact number | Highly restricted; never expose in logs/analytics |
| `emergencyContact.consentRecordedAt` | Evidence that the customer confirmed they have permission to share this number | Server timestamp |
| `petEmergencyInstructions` | Essential, booking-specific care instructions | Keep concise; avoid unnecessary medical history |
| `preferredVeterinaryClinic` | Clinic name and phone/address, only if customer chooses to provide it | Optional; booking-scoped |
| `updatedAt` | Audit/update timestamp | Server timestamp |

Do not assume that a customer has obtained third-party consent merely because a number was entered. The UI must explain why the number is requested and require an explicit confirmation before saving. Define deletion/retention periods before collecting real data.

## 3. Access policy proposal

| Actor | Proposed access |
|---|---|
| Customer who owns the booking | Read and update permitted safety context until the booking's configured cutoff; see who can access it |
| Walker assigned to the booking | Read only the minimum operational fields for a confirmed/in-progress booking; no edits to customer-provided contact data |
| Unassigned/backup/candidate Walker | No access, including during walker hold |
| Admin with server-issued Admin claim | Access only through audited support/incident workflows |
| Any other user | No access |

- Use callable functions for safety-context reads and writes until Firestore rules can enforce the same booking-state and field-level restrictions.
- Never rely on hiding a UI element as authorization.
- Derive actor UID from Firebase Auth; verify booking ownership/assignment and allowed status on every call.
- Do not expose customer phone, emergency-contact phone, pet instructions, or clinic details in general walker lists, dashboard summaries, notifications, analytics, or logs.
- Access should stop after the operational window defined by policy. Admin access must be logged with actor, booking, purpose, and timestamp.

## 4. Handover lifecycle proposal

1. Customer enters optional emergency contact and essential pet instructions during booking preparation or before confirmation.
2. Customer reviews exactly what the assigned Walker may see and confirms permission to share the emergency contact.
3. Server validates and stores the context in the private booking-scoped path.
4. After a booking is confirmed and a Walker is assigned, the assigned Walker can retrieve the minimum safety handover through an authenticated callable.
5. Walker acknowledges that the handover was reviewed. Store acknowledgement actor and timestamp; do not treat acknowledgement as proof that the walk is safe.
6. Access expires after the approved operational window. A reassignment revokes the previous Walker's access immediately.

## 5. Incident reporting proposal

Use a separate append-only incident record rather than editing the safety context or adding free-form notes to the booking:

```
bookings/{bookingId}/incidents/{incidentId}
```

Suggested minimum fields:

- `reportedByUid`, `reporterRole`, `createdAt` (server-derived)
- `incidentType` from a controlled list (for example: animal health, lost pet, injury, safety concern, customer unavailable, other)
- `severity` from an approved controlled list
- `occurredAt` (validated timestamp)
- `summary` (length-limited; no unnecessary sensitive details)
- `actionsTaken` (length-limited)
- `status` and `assignedAdminUid` (Admin-controlled)
- optional evidence references only after upload access, file type/size limits, malware handling, retention, and deletion policy are defined.

A Walker may submit an incident only for a booking assigned to that Walker and within the approved reporting window. A customer may submit a booking-related safety concern for their own booking. Only authorized Admin workflows may triage, assign, resolve, or export incident records. Preserve an audit trail; do not permit clients to overwrite or delete reports.

## 6. Callable/API contract candidates (not implemented)

Names are illustrative and must be reviewed before adoption:

- `saveBookingSafetyContext`: customer-only; validates ownership, consent, field allowlist, length limits, and booking state.
- `getWalkerBookingHandover`: assigned Walker only; returns a minimized payload only for confirmed/in-progress bookings and records access.
- `acknowledgeBookingHandover`: assigned Walker only; records server timestamp and actor UID.
- `reportBookingIncident`: validates booking participation, role, status, controlled values, and rate limits.
- Admin-only incident list/update functions: require the server-issued Admin custom claim and append audit events.

Every callable must reject client-supplied actor IDs, timestamps, roles, assignment claims, and Admin flags. Use App Check where supported, rate limits, generic errors, and structured redacted logs.

## 7. Required decisions before implementation

- Who is the emergency contact, and is it optional or mandatory for a given booking?
- What exact customer consent wording and third-party permission process is approved?
- Which fields can the assigned Walker see, and at what exact booking statuses/times?
- What happens if the customer cannot be reached, the emergency contact does not answer, or urgent veterinary care is required?
- Who pays for emergency treatment, and who may authorize it?
- What are the escalation contacts, operating hours, response-time targets, and out-of-hours process?
- What are retention, deletion, access-review, and breach-notification requirements for contact and incident data?
- What evidence (photos/documents) is permitted, and what safeguards are required?
- Who owns Admin incident triage and audit review?

## 8. Acceptance criteria for a future implementation

- Automated authorization tests cover owner, assigned Walker, unassigned Walker, reassigned Walker, Admin, and unrelated user.
- No candidate or unassigned Walker can read the private safety context.
- A reassigned Walker immediately loses access.
- Client-supplied UID, role, assignment, Admin claim, and timestamps are ignored/rejected.
- Incident reports are append-only for reporters and Admin actions are audited.
- Logs, analytics, notifications, and ordinary dashboard responses contain no emergency phone or unnecessary sensitive details.
- Retention/deletion and escalation procedures are approved and documented.
- Emulator tests validate Firestore rules and callable authorization before any deployment.

**No schema, callable, Firestore rule, or app UI change is authorized by this RFC. It records a safe proposal and explicit decision gates only.**


## 9. Decision register and implementation go/no-go

Use this register in a product/operations/privacy/legal review. **All entries begin as open; no default or implied approval is granted by this RFC.** Record the named decision owner, approved wording/policy, date, and evidence before changing an entry to approved.

| Decision area | Required recorded outcome | Accountable reviewer(s) | Status |
|---|---|---|---|
| Emergency-contact requirement | Optional/mandatory policy by booking type, and any exception path | Product + Operations | Open |
| Third-party permission and customer consent | Approved consent copy, confirmation method, and handling when permission is unavailable | Privacy + Legal + Product | Open |
| Walker-visible handover | Exact field allowlist, booking states, access start/end, and reassignment revocation behavior | Operations + Privacy | Open |
| Customer unreachable / urgent veterinary care | Step-by-step escalation tree, emergency thresholds, fallback contacts, and out-of-hours procedure | Operations | Open |
| Treatment authorization and payment | Who can authorize treatment, spending limits if any, and payment responsibility | Product + Operations + Legal | Open |
| Service coverage and response targets | Named operational owner, staffed hours, response-time targets, and escalation backup | Operations | Open |
| Retention, deletion, and access audit | Retention periods by data type, deletion triggers, access-review cadence, and breach process | Privacy + Legal + Security | Open |
| Photos and other evidence | Allowed evidence types, upload controls, access, retention, and deletion safeguards | Privacy + Security + Operations | Open |
| Incident triage ownership | Admin queue owner, severity definitions, assignment/closure authority, and audit reviewer | Operations + Admin owner | Open |

### Required approval record

For each decision above, capture:
- Decision ID and final approved policy text.
- Named accountable approver(s), role, approval date, and any conditions.
- Customer-facing wording or operational runbook reference, where applicable.
- Data classification, retention/deletion rule, and access scope affected.
- Testable acceptance criteria and the person responsible for sign-off.

### Go/no-go rule

Implementation may be proposed only after every applicable decision is approved and the operational runbook exists. Then create a separate implementation plan covering schema migration, callable authorization, Firestore rules, audit logging, app UX, emulator/security tests, rollout, support training, and rollback. Any unresolved emergency escalation, consent, access, or retention decision is a **no-go** for collecting or exposing the corresponding sensitive data.

This register is a review aid, not evidence that any stakeholder has approved the proposed design.
