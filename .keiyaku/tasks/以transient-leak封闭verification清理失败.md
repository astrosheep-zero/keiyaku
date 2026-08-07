---
id: task/以transient-leak封闭verification清理失败
title: 以transient leak封闭Verification清理失败
state: done
priority: 0
needs: []
parent: null
supersedes: []
relates: []
contractId: null
---
按 docs/public-api.md、docs/verification.md、docs/lifecycle.md、docs/cli.md：post-admission dispose 失败保持 accepted，仅报告一次 worktree leak，不进 journal/reconcile。