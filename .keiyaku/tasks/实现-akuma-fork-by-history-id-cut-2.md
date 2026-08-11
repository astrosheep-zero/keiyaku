---
id: task/实现-akuma-fork-by-history-id-cut-2
title: 实现 Akuma fork-by-history-id Cut 2
state: done
priority: 1
needs:
  - task/实现-akuma-status-wait-与唯一-history-投
  - task/实证-claude-fork-harness-原语
  - task/faye-复核-akuma-capability-harness-架构里
parent: null
supersedes: []
relates: []
note: ""
createdAt: 2026-08-08T17:33:08.603Z
updatedAt: 2026-08-08T23:05:27.571Z
---
依据 docs/akuma.md Reserved Cut 2，在 provider-native fork primitive 已有证据后，同一 coherent change 成文并实现 source handle fork({ at: historyId })：heart 唯一读取 retained answered turn/fork-point fact，failed 或未保留历史 typed 拒绝；adapter 执行 native fork；随后复用普通目录原子分配、leash claim 与 birth 路径，child soul 记录 sourceId/historyId lineage。native 成功但本地 publication 失败返回 typed upstreamForked evidence；source dead 仍允许从 retained history fork。不复制 SQLite/session id，不建第二 birth 路径。