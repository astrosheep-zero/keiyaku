---
id: task/v4-architecture-correct-extensible-mvp
title: v4 architecture-correct extensible MVP
state: done
priority: 0
needs:
  - task/v4-day1-cli-分层与-task-settlement
  - task/v4-here-复用调用者-worktree
  - task/v4-amend-five-h2-operations-and-diff-hint
  - task/v4-task-mutation-diff-result-boundary
  - task/v4-managed-terminal-cleanup-ordering
  - task/v4-status-audit-wait-read-surfaces
parent: null
supersedes: []
relates: []
note: ""
createdAt: 2026-08-06T04:53:11.516Z
updatedAt: 2026-08-07T11:29:07.430Z
contractId: null
---
Close the architecture-defined MVP before dogfooding. Verify the authority documents and source agree on the current intent surface, journal-only lifecycle authority, complete-body amend boundary, CLI/core/task dependency direction, repository and Git ownership, result rendering, restart/retry semantics, and deletion of superseded v3 mechanisms. Require focused tests and source-only typecheck; do not add compatibility aliases or speculative extension points.