---
id: v4-dogfood-e2e-current-intent-surface
title: "v4 dogfood E2E: current intent surface"
state: open
pri: 1
needs:
  - v4-day1-cli-分层与-task-settlement
  - v4-here-复用调用者-worktree
  - v4-amend-five-h2-operations-and-diff-hint
parent: null
from: []
createdAt: 2026-08-05T08:47:41.496Z
updatedAt: 2026-08-05T08:47:41.496Z
creator: thekoc
---
Exercise the built `keiyaku-v4` binary through real shell processes using only the current command law.

Cover managed-worktree fulfillment (`bind -> deliver -> review --approve`), changes-requested followed by a replacement delivery and approval, terminal `abandon`, and `--here` without Keiyaku-owned checkout mutation. Assert canonical journal facts, target CAS behavior, candidate pin and managed-worktree cleanup, unchanged caller-owned worktrees, task settlement, diff hints, text output, and typed failures. The test must consume the public CLI rather than calling verb internals.
