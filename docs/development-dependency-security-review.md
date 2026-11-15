# Development Dependency Security Review

**Reviewed:** 2026-11-15  
**Repository:** `DOJOWALK/dojo-walk-firebase`  
**Branch:** `feat/orange-primary-blue-secondary`  
**Evidence:** Initial audit run [#130](https://github.com/DOJOWALK/dojo-walk-firebase/actions/runs/43712217219); latest verified CI run [#135](https://github.com/DOJOWALK/dojo-walk-firebase/actions/runs/43716452908), commit `4dc451d8c94eb74f4cdcde3ecb796f347ecf16ab`.

## Current audit position

- Production dependency audit (`npm audit --omit=dev`): 0 critical, 0 high, 0 moderate, 0 low, 0 info.
- Full dependency tree: 13 moderate-severity affected package entries; no high or critical findings.
- The affected packages reported by the full audit are in the development/test toolchain. The production-only audit is clean.
- Latest CI run #135 passed all 35 tests: build/unit 17, Firestore rules 5, payment finalizer 5, walker reservation 4, recurring-series lifecycle 4.
- CI now enforces `npm audit --audit-level=high` across the full dependency tree and `npm audit --omit=dev --audit-level=moderate` for production dependencies. Both gates passed in run #135.

## Advisory review and dependency constraints

| Package in lockfile | Locked version | Advisory / status | Dependency constraint |
|---|---:|---|---|
| `@opentelemetry/core` | 1.30.1 | GHSA-8988-4f7v-96qf; patched in 2.8.0 | Pulled by `@google-cloud/pubsub@5.3.1`, which requests `^1.30.1`. Moving to 2.x needs a compatible Pub/Sub / Firebase CLI dependency update. |
| `glob` | 10.5.0 | GHSA-3g3m-2fjr-6pw4; patched in 14.0.2 | Firebase CLI 15.36.0, archiver-utils, exegesis and rimraf request glob 10.x. A global override to 14.x violates those declared ranges. |
| nested `minimatch` | 9.0.9 | GHSA-g3hv-75wg-m249; patched in 11.0.1 | The vulnerable copy is required by glob 10.x (`^9.0.4`). Firebase CLI also has its own minimatch 3.x dependency; the root 3.1.5 copy is outside this advisory's affected range. |
| `uuid` | 9.0.1 | GHSA-w5hq-g745-h8pq; patched in 11.1.1 for the affected range | Firebase CLI's nested gaxios 6.7.1 requests uuid `^9.0.1`; forcing uuid 11.x would violate that range. |

The full audit also reports transitive package entries for `archiver`, `archiver-utils`, `exegesis`, `gaxios`, `google-gax`, `rimraf`, and `zip-stream`. These are part of the same development-tool dependency graph; the production-only audit does not report them as vulnerable production dependencies.

## Latest upstream compatibility check

- On 2026-11-15, npm lists `firebase-tools@15.36.0` as the `latest` tag; the Firebase CLI release history also identifies v15.36.0 as the newest release. The repository already pins this version through `^15.36.0` and its lockfile.
- The current CLI dependency graph includes `@google-cloud/pubsub@5.3.1`, `archiver@7.0.1`, `exegesis@4.3.0`, `gaxios@6.7.1`, and `glob@10.5.0`. The audited vulnerable ranges are pulled in by those declared dependencies.
- The npm audit's suggested automatic fix is a downgrade to `firebase-tools@13.11.2` and is marked SemVer-major. It is not an acceptable automatic security update: it would roll back two major CLI generations and could regress emulator/CI behavior.
- No newer stable Firebase CLI release was available in this review to test as a remediation. Therefore no dependency version or override was changed. Re-evaluate when Firebase CLI updates its dependency ranges or publishes a newer stable release.

## Remediation decision

No blanket `npm audit fix --force` and no major-version overrides were applied. The audit's suggested Firebase CLI fix target (`13.11.2`) is a downgrade from the currently locked `15.36.0`; it is not accepted as a safe remediation without a compatibility review.

The safe next step is to update the owning development-tool packages when they publish compatible dependency ranges, then regenerate the lockfile with `npm ci` validation and run every Emulator suite. Until then:
- Keep both the full-tree High/Critical audit gate and the production Moderate+ audit gate in CI.
- Keep the full development dependency audit visible in CI logs and job summary.
- Recheck the advisories on the next scheduled dependency review.
- Do not treat this development-tool finding set as proof of a production runtime vulnerability.

This document records the review and its rationale; it does not claim that the development dependency advisories have been fixed.
