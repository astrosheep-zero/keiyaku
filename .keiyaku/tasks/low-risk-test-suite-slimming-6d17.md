---
id: task/low-risk-test-suite-slimming-6d17
title: Low-risk test suite slimming
state: done
priority: 1
needs: []
parent: task/test-suite-slimming-and-a161
supersedes: []
relates: []
note: ""
createdAt: 2026-09-02T12:22:07.434Z
updatedAt: 2026-09-02T13:05:13.435Z
---
Merge or remove only duplicate/ghost tests while preserving one externally meaningful invariant per case.

Candidates: library-nuke into nuke; cli-task into task-cli; deleted-symbol checks in maintainability; duplicate help snapshots; provider/configuration and pure-arithmetic matrices where a representative table-driven assertion remains. Reduce facade-fleet and facade-contract fixtures only to the smallest values that still cross their pagination/pruning boundaries.

Acceptance: manifest and test files agree; focused tests pass; integration timing improves or the report explains why it does not; no lifecycle happy path or first retry/restart boundary is lost.