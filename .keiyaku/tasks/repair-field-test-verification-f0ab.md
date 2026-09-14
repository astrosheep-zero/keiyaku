---
id: task/repair-field-test-verification-f0ab
title: Repair field-test verification failures and add duration coverage
state: done
priority: 2
needs: []
parent: null
supersedes: []
relates: []
note: Fixed async Square fixture activation and rejected-completion barrier release, TS/JS publication loader, independent-cancellation assertions, and emitted-handler timer cleanup; added duration regression tests and registrations. Source and compiled focused runs each 105/105 pass; npm test full release sweep, test:typecheck, build stage, lint and diff check pass. Independent reviewer aku/review-akuma/21edbdf1 reported no findings. Changes remain uncommitted; pre-existing work preserved.
createdAt: 2026-09-12T08:08:48.505Z
updatedAt: 2026-09-12T08:54:33.932Z
---
Align plugin completion tests with bounded emit, diagnose Akuma barrier and schema publication failures, incorporate isolated duration coverage, and run focused plus full verification. Preserve unrelated working changes.