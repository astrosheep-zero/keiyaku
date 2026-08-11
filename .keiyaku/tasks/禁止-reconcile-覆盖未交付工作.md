---
id: task/禁止-reconcile-覆盖未交付工作
title: 禁止 reconcile 覆盖未交付工作
state: done
priority: 0
needs: []
parent: null
supersedes: []
relates: []
note: ""
createdAt: 2026-08-07T05:55:53.904Z
updatedAt: 2026-08-07T11:29:07.460Z
---
已用真实 Git 仓库复现：managed worktree 从 bind 的 A 提交到未 deliver 的 B，随后 arc accepted 后 CLI 通用 accepted 路径调用 reconcile，carrier/reconcile.ts 将 worktree reset --hard 回 A。journal 只拥有已 tender candidate，不能把未 tender 工作当作由 journal 派生的 lag。先按 owner law 裁定 active managed worktree 的内容所有权，再删除覆盖路径；保留 topology 创建、terminal 清理、delivery/candidate ref 修复。需要真实 shell 回归证明普通 accepted verb 不移动未交付 HEAD。

同类破坏不止 active reset：terminal reconciliation 还先删 owned refs，再用 `git worktree remove --force` 删除 managed worktree。若最后一次 tender 后仍有未 tender 修改，这同样丢失不属于 journal 的内容。裁决必须同时覆盖 active 对齐与 terminal 清理的内容所有权；不能只删除 reset 路径。

Faye act_362 closes the law: never reset/switch/detach an existing managed worktree and never force-remove it. Terminal removal requires clean status including untracked, HEAD equal to last accepted candidate or creation start, and matching HEAD tree; otherwise retain worktree plus reachability refs/pins and return typed `worktree-retained` flat cleanup lag without flipping accepted. No-delivery abandon uses the start arm.