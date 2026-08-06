---
id: 禁止-reconcile-覆盖未交付工作
title: 禁止 reconcile 覆盖未交付工作
state: open
pri: 0
needs: []
parent: null
from: []
createdAt: 2026-08-06T22:21:38.341Z
updatedAt: 2026-08-06T22:21:38.341Z
creator: thekoc
---
已用真实 Git 仓库复现：managed worktree 从 bind 的 A 提交到未 deliver 的 B，随后 arc accepted 后 CLI 通用 accepted 路径调用 reconcile，carrier/reconcile.ts 将 worktree reset --hard 回 A。journal 只拥有已 tender candidate，不能把未 tender 工作当作由 journal 派生的 lag。先按 owner law 裁定 active managed worktree 的内容所有权，再删除覆盖路径；保留 topology 创建、terminal 清理、delivery/candidate ref 修复。需要真实 shell 回归证明普通 accepted verb 不移动未交付 HEAD。
