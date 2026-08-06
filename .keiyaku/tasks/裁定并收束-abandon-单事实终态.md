---
id: 裁定并收束-abandon-单事实终态
title: 裁定并收束 abandon 单事实终态
state: open
pri: 1
needs:
  - attestation-subject-统一证词与-gat-da92658b
parent: null
from: []
createdAt: 2026-08-06T05:42:56.344Z
updatedAt: 2026-08-06T05:42:56.344Z
creator: thekoc
---
当前 abandon 与 abandoned 永远在同一 Offer 原子共生，不存在可观察中间态；finalHead 只有 writer/codec，没有 lifecycle、gate、status、audit 或 reconcile 读者，还为 journal-only 终止额外增加一次 target ref 读取。lifecycle 文档同时把 abandon 描述为合法终态，模型出现双重表示。

这是 persisted model 删除，实施前按 v4 规则让 Faye 对单事实终态成果提出反对。若确认，令 abandon fact 自身成为 terminal，保留 note，删除 abandoned/finalHead/ContractState.abandon/第二 ULID 与对应 codec/fold/test 分支；public phase 仍可投影为 abandoned。零兼容、零迁移。
