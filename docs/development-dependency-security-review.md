# Development Dependency Security Review

**Reviewed:** 2026-11-15  
**Repository:** `DOJOWALK/dojo-walk-firebase`  
**Branch:** `feat/orange-primary-blue-secondary`  
**Evidence:** GitHub Actions run [#130](https://github.com/DOJOWALK/dojo-walk-firebase/actions/runs/43712217219), commit `02d7fe3ffa97f21654c53aa6a24034890ea67bba`.

## Current audit position

- Production dependency audit (`npm audit --omit=dev`): 0 critical, 0 high, 0 moderate, 0 low, 0 info.
- Full dependency tree: 13 moderate-severity affected package entries; no high or critical findings.
- The affected packages reported by the full audit are in the development/test toolchain. The production-only audit is clean.
- The CI run passed all 35 tests across build/unit, Firestore rules, payment finalizer, walker reservation, and recurring-series lifecycle suites.

## Advisory review and dependency constraints

| Package in lockfile | Locked version | Advisory / status | Dependency constraint |
|---|---:|---|---|
| `@opentelemetry/core` | 1.30.1 | GHSA-8988-4f7v-96qf; patched in 2.8.0 | Pulled by `@google-cloud/pubsub@5.3.1`, which requests `^1.30.1`. Moving to 2.x needs a compatible Pub/Sub / Firebase CLI dependency update. |
| `glob` | 10.5.0 | GHSA-3g3m-2fjr-6pw4; patched in 14.0.2 | Firebase CLI 15.36.0, archiver-utils, exegesis and rimraf request glob 10.x. A global override to 14.x violates those declared ranges. |
| nested `minimatch` | 9.0.9 | GHSA-g3hv-75wg-m249; patched in 11.0.1 | The vulnerable copy is required by glob 10.x (`^9.0.4`). Firebase CLI also has its own minimatch 3.x dependency; the root 3.1.5 copy is outside this advisory's affected range. |
| `uuid` | 9.0.1 | GHSA-w5hq-g745-h8pq; patched in 11.1.1 for the affected range | Firebase CLI's nested gaxios 6.7.1 requests uuid `^9.0.1`; forcing uuid 11.x would violate that range. |

The full audit also reports transitive package entries for `archiver`, `archiver-utils`, `exegesis`, `gaxios`, `google-gax`, `rimraf`, and `zip-stream`. These are part of the same development-tool dependency graph; the production-only audit does not report them as vulnerable production dependencies.

## Remediation decision

No blanket `npm audit fix --force` and no major-version overrides were applied. The audit's suggested Firebase CLI fix target (`13.11.2`) is a downgrade from the currently locked `15.36.0`; it is not accepted as a safe remediation without a compatibility review.

The safe next step is to update the owning development-tool packages when they publish compatible dependency ranges, then regenerate the lockfile with `npm ci` validation and run every Emulator suite. Until then:
- Keep the production audit as a CI gate.
- Keep the full development dependency audit visible in CI logs and job summary.
- Recheck the advisories on the next scheduled dependency review.
- Do not treat this development-tool finding set as proof of a production runtime vulnerability.

This document records the review and its rationale; it does not claim that the development dependency advisories have been fixed.
