---
id: task/usability/repair-queued-amend-fixture-4ad7
title: Repair queued-amend fixture readiness barrier
state: done
priority: 1
needs: []
parent: task/usability/investigate-inconsistent-full-6096
supersedes: []
relates: []
note: ""
createdAt: 2026-09-09T16:10:37.508Z
updatedAt: 2026-09-10T00:40:27.626Z
---
Confirmed by suite-investigation/REPORT.md: ready only proves the seat is held, not that old terms were captured. Preserve real cross-process admission and same-source stale rejection by a content-aware test barrier or explicit old-source fixture intent. Do not change production seat semantics, weaken accepted-count assertions, skip checks, or substitute arbitrary sleeps. Implement in an isolated Contract worktree and obtain independent review plus full Verification.
Claimed/placed a03176f03335a3169613f25dd347286152d69c7f over schema repair 7e7b7e8 after independent exact integration review and full audit Verification 4/4. Redelivery reused that exact audit evidence. Test-only candidate unchanged; old ENOTEMPTY/Busy failures retained as earlier-snapshot evidence. Current plugin-runtime ENOTEMPTY risk remains separate and unlanded. Receipts: evidence/amend-fixture-audit-after-schema.json, amend-fixture-final-review-after-schema.json, amend-fixture-redelivery-after-schema.json.