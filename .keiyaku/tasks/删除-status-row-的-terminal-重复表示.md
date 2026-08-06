---
id: 删除-status-row-的-terminal-重复表示
title: 删除 status row 的 terminal 重复表示
state: in_progress
pri: 0
needs:
  - 收束-core-decision-observation-为唯-5ab4af33
parent: null
from: []
createdAt: 2026-08-06T21:22:59.003Z
updatedAt: 2026-08-06T21:42:06.362Z
creator: thekoc
startedAt: 2026-08-06T21:42:06.362Z
---
按 docs/public-api.md，ContractStatus 只以 phase 表示 lifecycle；删除完全可由 claimed/abandoned phase 推出的 terminal 字段，CLI worktree selector 直接读 phase。workspace 来自 total ContractCoordinates，收紧为 worktree|here，不允许生产不可构造的 null。更新精准 public/CLI tests，不新增 derived boolean。
