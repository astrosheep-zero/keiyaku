---
id: task/faye-复核-akuma-cut-2-fork-架构里程碑
title: Faye 复核 Akuma Cut 2 fork 架构里程碑
state: done
priority: 1
needs:
  - task/实现-akuma-fork-by-history-id-cut-2
parent: null
supersedes: []
relates: []
note: ""
createdAt: 2026-08-08T17:41:08.405Z
updatedAt: 2026-08-08T23:15:42.334Z
contractId: null
---
在 fork-by-history-id 的 provider-native、heart projection、ordinary birth reuse、lineage 与 upstreamForked typed evidence 全部实现并验证后，向 Faye 提交一次 Cut 2 架构里程碑 review。重点做根因级检查：fork 是否真实落在 native harness 而非复制 session；historyId 与 retained answered turn 是否唯一坐标；dead-source fork 是否保持 history 长寿；native 成功/本地发布失败是否可表示；是否产生第二 birth path、重复 projection、跨层 SQL 或双权威。可持续裁决归入 docs/akuma.md，同 change 修正后再完成任务。