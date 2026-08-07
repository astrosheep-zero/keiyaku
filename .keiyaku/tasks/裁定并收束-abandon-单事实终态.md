---
id: task/裁定并收束-abandon-单事实终态
title: 删除 abandon 跨快照 finalHead
state: done
priority: 1
needs:
  - task/attestation-subject-统一证词与-gat-da92658b
parent: null
supersedes: []
relates: []
note: ""
createdAt: 2026-08-07T05:25:48.467Z
updatedAt: 2026-08-07T11:29:07.461Z
contractId: null
---
依据 docs/model.md 与 docs/lifecycle.md，删除 abandonment 中没有读者的 target 快照。

现状已经只有一个 abandoned terminal fact，不存在 abandon/abandoned 双事实。真正的可构造问题是 finalHead 没有 lifecycle、gate、status、audit 或 reconcile 读者；abandonOperation 为写它先观察 target/ref，随后 admitIntent 又观察第二份世界，可能把旧快照的 finalHead 写进新快照决定的事实。

完成条件：

- 保留单一 abandoned terminal fact 和可选 note；AbandonedData 收缩为 { note? }，删除 finalHead 及对应 codec/test 分支。
- public phase 仍投影为 abandoned；journal、status、audit 与 reconcile 不新增补偿字段或兼容分支。
- abandon 不再读取 target ref，也不存在 admission 之前的独立 contract observation；一个 attempt 只使用自己的 observation。
- current-version-only 更新 owner docs、persisted codec、fixtures 和精准测试；零迁移、零兼容 decoder。