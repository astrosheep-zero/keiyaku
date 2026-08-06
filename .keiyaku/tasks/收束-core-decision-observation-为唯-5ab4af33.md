---
id: 收束-core-decision-observation-为唯-5ab4af33
title: 收束 core decision observation 为唯一状态投影
state: done
pri: 0
needs:
  - 收束-deliver-review-preparation-的-l-0b2cd495
parent: null
from: []
createdAt: 2026-08-06T20:32:52.252Z
updatedAt: 2026-08-06T21:40:29.102Z
creator: thekoc
---
按 docs/model.md 的 pure pact 边界与“contract absence 只有 state:null 一种表示”重塑观察接口。纯 decide 实际只读按 ContractId 索引的 ContractState|null；raw journal entries 仅由 carrier/protocol unknown recovery 与 audit 读取，不进入 core decision projection。删除 ContractObservation 中可互相矛盾的 id/entries/state 复合形；每个请求 identity 必须显式存在于 decision map，缺 key 是 programmer invariant error，不得伪装成 contract-missing 或 unknown-prerequisite。保持每 attempt 单 carrier snapshot、receipt folding 和 unknown canonical-byte recovery。
