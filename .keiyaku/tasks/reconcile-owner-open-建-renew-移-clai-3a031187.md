---
id: reconcile-owner-open-建-renew-移-clai-3a031187
title: reconcile owner：open 建 / renew 移 / claim+forfeit 清场
state: in_progress
pri: 1
needs: []
parent: null
from: []
createdAt: 2026-08-04T06:15:05.088Z
updatedAt: 2026-08-04T08:37:21.749Z
creator: thekoc
startedAt: 2026-08-04T08:37:21.749Z
---
reconcile 实现与测试完全缺失（open.ts 只 journal，无 ref/worktree effect）。按 Reconcile Law 实现：open 建 delivery ref@head + conventional worktree；renew 移 ref 至 newHead + 刷新 worktree；petition 无 effect；claim/forfeit 删 ref+worktree（delivery 存在时）。ref 名/worktree 路径 = 由合同身份推导的私有约定，非 fact。验收含 Nail 3：null handoff、重启、重复调用幂等。
