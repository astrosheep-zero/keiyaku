---
id: task/以transient-leak封闭verification清理失败
title: 以transient leak封闭Verification清理失败
state: done
priority: 0
needs: []
parent: null
supersedes: []
relates: []
note: ""
createdAt: 2026-08-07T04:47:53.994Z
updatedAt: 2026-08-07T11:29:07.443Z
---
按 docs/public-api.md、docs/verification.md、docs/lifecycle.md、docs/cli.md：post-admission dispose 失败保持 accepted，仅报告一次 worktree leak，不进 journal/reconcile。