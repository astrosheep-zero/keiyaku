---
id: 以transient-leak封闭verification清理失败
title: 以transient leak封闭Verification清理失败
state: open
pri: 0
needs: []
parent: null
from: []
createdAt: 2026-08-06T18:10:23.909Z
updatedAt: 2026-08-06T18:10:23.909Z
creator: thekoc
---
按 docs/public-api.md、docs/verification.md、docs/lifecycle.md、docs/cli.md：post-admission dispose 失败保持 accepted，仅报告一次 worktree leak，不进 journal/reconcile。
