---
id: task/full-verification-and-regression-27a9
title: Full verification and regression report
state: done
priority: 1
needs:
  - task/git-and-process-performance-9c6e
  - task/low-risk-test-suite-slimming-6d17
  - task/test-workflow-layering-and-dfa7
parent: task/test-suite-slimming-and-a161
supersedes: []
relates: []
note: "Read-only final regression completed. local passed: 29 files, 12.506s. integration ran 53 files for 202.096s and stopped on an environment failure: listen EPERM on 127.0.0.1 in the Pi/OpenAI chat completion test. test:typecheck and npm test were not run after fail-fast. No source changes in the verification worktree; residual risk is a clean environment release run."
createdAt: 2026-09-02T12:22:07.434Z
updatedAt: 2026-09-02T13:14:50.940Z
---
Run focused checks for every changed surface, then the appropriate local, integration, typecheck, and release commands. Record exact elapsed times, failures, and residual risk. Confirm that the final manifests still cover the normal end-to-end path and the first retry/restart boundary.