---
id: task/v4-dogfood-e2e-current-intent-surface
title: "v4 dogfood E2E: current intent surface"
state: drop
priority: 1
needs:
  - task/v4-architecture-correct-extensible-mvp
parent: null
supersedes: []
relates: []
contractId: null
---
Exercise the built `keiyaku-v4` binary through real shell processes using only the current command law.

Cover managed-worktree fulfillment (`bind -> deliver -> review --approve`), changes-requested followed by a replacement delivery and approval, terminal `abandon`, and `--here` without Keiyaku-owned checkout mutation. Assert canonical journal facts, target CAS behavior, candidate pin and managed-worktree cleanup, unchanged caller-owned worktrees, task settlement, diff hints, text output, and typed failures. The test must consume the public CLI rather than calling verb internals.

Superseded by completed v4-day1-dogfood-bin and its packed installed-binary shell coverage.