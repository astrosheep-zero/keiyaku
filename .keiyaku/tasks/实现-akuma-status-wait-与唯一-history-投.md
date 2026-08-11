---
id: task/实现-akuma-status-wait-与唯一-history-投
title: 实现 Akuma status wait 与唯一 history 投影
state: done
priority: 0
needs:
  - task/实现-akuma-profile-配置输入与快照
parent: null
supersedes: []
relates: []
note: ""
createdAt: 2026-08-08T17:32:37.634Z
updatedAt: 2026-08-08T19:16:08.378Z
---
依据 docs/akuma.md 与 Faye act_56 方案 A，在同一 coherent change 中成文并实现 heart.readHistory() 作为 turns 全量 outcome sum 的唯一 SQL 投影；akuma.ts 组合 status() 与 wait(predicate?)，status 返回 life/history/confinement/profile description，wait 默认等待非 running 并返回同一 status 形状。删除 observation()/comeback()、Comeback 与 AkumaObservation，替换 CLI/Kanshi 读面，不保留 alias 或第二条投影路径。覆盖 answered/failed/dead/pending/concurrent observation 与 wait 终止测试，运行完整 verification。同一 history fact cut 同时吸收 Faye act_62 的 Cut 1 不变量：historyId 硬切为 provider-owned fork point；answered TurnFact 自带实际 ResumeCoordinate session；Claude 使用 outer assistant UUID 而非 result UUID。provider fork primitive 与 fork verb 仍属后续 Cut 2。