---
id: 裁定并收束-abandon-单事实终态
title: 删除 abandon 双事实终态与跨快照 finalHead
state: open
pri: 1
needs:
  - attestation-subject-统一证词与-gat-da92658b
parent: null
from: []
createdAt: 2026-08-06T05:42:56.344Z
updatedAt: 2026-08-07T05:09:32.423Z
creator: thekoc
---
依据 docs/model.md 与 docs/lifecycle.md，把 abandon 收束为一个事实和一个终态判断。

当前可构造问题：abandon 与 abandoned 永远在同一 Offer 原子共生；finalHead 没有 lifecycle、gate、status、audit 或 reconcile 读者。abandonOperation 还先观察 target/finalHead，再由 admitIntent 观察第二份世界，可能把旧快照的 finalHead 写进新快照决定的事实。

完成条件：

- abandon fact 自身成为 terminal，保留 note；删除 abandoned fact、finalHead、ContractState.abandon、第二个 EntryUlid 及对应 codec/fold 分支。
- public phase 仍投影为 abandoned；journal、status、audit 与 reconcile 不新增补偿字段或兼容分支。
- abandon 不再读取 target ref，也不存在 admission 之前的独立 contract observation；一个 attempt 只使用自己的 observation。
- current-version-only 更新 owner docs、persisted codec、fixtures 和精准测试；零迁移、零兼容 decoder。
