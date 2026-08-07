---
id: task/reconcile-owner-open-建-renew-移-clai-3a031187
title: reconcile owner：open 建 / renew 移 / claim+forfeit 清场
state: done
priority: 1
needs: []
parent: null
supersedes: []
relates: []
note: ""
createdAt: 2026-08-04T09:02:34.933Z
updatedAt: 2026-08-07T11:29:07.426Z
contractId: null
---
reconcile 实现与测试完全缺失（open.ts 只 journal，无 ref/worktree effect）。按 Reconcile Law 实现：open 建 delivery ref@head + conventional worktree；renew 移 ref 至 newHead + 刷新 worktree；petition 无 effect；claim/forfeit 删 ref+worktree（delivery 存在时）。ref 名/worktree 路径 = 由合同身份推导的私有约定，非 fact。验收含 Nail 3：null handoff、重启、重复调用幂等。

Accepted implementation commit 15161d7. Added one v4-native reconcile owner with deterministic private delivery ref/worktree conventions, open/renew alignment, petition no-op, claimed/forfeited cleanup, null-handoff/restart/idempotence, and newer-target protection. Independent review-akuma/v4-approve-reconcile-review returned no findings. Coordinator verification: 7 reconcile-focused tests, full suite 111/111, typecheck, build, and diff check pass.