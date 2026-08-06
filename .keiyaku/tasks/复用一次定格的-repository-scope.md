---
id: 复用一次定格的-repository-scope
title: 复用一次定格的 repository scope
state: in_progress
pri: 1
needs: []
parent: null
from: []
createdAt: 2026-08-06T05:43:56.092Z
updatedAt: 2026-08-06T05:49:12.569Z
creator: thekoc
startedAt: 2026-08-06T05:49:12.569Z
---
Repo/Keiyaku 已保存 PinnedScope 的 coordinate 与 root，但每个 public method 只把 coordinate 传给 protocol；protocol 随即 repositoryAt(coordinate) 并再次执行 git worktree list。一个常见 CLI 写操作会在 selector、handle construction、verb 与 accepted reconcile 路径重复发现同一 repository world。

保持 GitRepository 私有且不穿透 package root；让 library 持有的私有 resolved scope 完整流向 protocol/carrier，repository discovery 只在公开 construction/scope acquisition 发生一次。删除 scopeOperation 的字符串往返和未使用的已定格字段。以注入计数或 fake git 精准测试证明同一 handle 的后续 state/deliver/reconcile 不再重复执行 worktree discovery。
