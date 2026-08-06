---
id: 拆除复合-admission-receipt-与-plac-5a098c75
title: 拆除复合 admission receipt 与 placement 吞错
state: in_progress
pri: 0
needs:
  - attestation-subject-统一证词与-gat-da92658b
parent: null
from: []
createdAt: 2026-08-06T05:42:38.723Z
updatedAt: 2026-08-06T09:13:08.258Z
creator: thekoc
startedAt: 2026-08-06T09:13:08.258Z
---
当前 deliver/review 在一个 public verb 内顺序执行多个独立 admission，再把多次事实拼成一个 receipt。后续 verification/placement 的 refused、retry、ref-moved 会被前一步 accepted 吞掉；receipt 的 prior/facts/snapshot 也不再对应一个 winning decision。

先在 lifecycle/public-api 定清：需要原子性的事实进入一个 Offer；需要分步的动作保留各自可观察结果，不合成虚构单次 admission。实现时删除 placeIfEligible 的协议层预判，让 decidePlacement 成为唯一裁判。新增目标 ref 在 review/placement 间漂移的精准测试，禁止调用返回普通 accepted 而契约仍未 claimed 且失败不可见。
