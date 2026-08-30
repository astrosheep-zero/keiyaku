---
id: task/prove-worldroot-at-every-raw-execution-boundary/architecture-policy-and-serial
title: Enforce World cast policy and verify after Result fixture rebase
state: done
priority: 0
needs:
  - task/prove-worldroot-at-every-raw-execution-boundary/package-root-library-world
  - task/prove-worldroot-at-every-raw-execution-boundary/body-and-routed-request-world
parent: null
supersedes: []
relates: []
note: ""
createdBy: aku/worker/0d24a604
createdAt: 2026-08-29T09:44:30.778Z
updatedAt: 2026-08-29T19:19:57.508Z
---
Keep the no-production-WorldRoot-cast policy. After Result lands its canonical ProviderAttempt fixture repair and this worktree is mechanically rebased, run the declared Contract verification serially with npm.
Host rebased onto Result/main 5c3139a. Resolved Result schema/direct-live-result/opaque-failure law with one-time World proof at Task command execution; no conflict markers remain. Rebase-safe evidence: npm run test:typecheck; focused task-operations, akuma-body-requests, and public-library all pass.
Corrected Body call context: upstreamFor carries its once-proven launch World through generic upstream; call execution now proves only transported request.world and compares it to that capability. Added an alias-launch-path composition regression; build and the amended eight-file focused suite passed.