---
id: task/实现-akuma-interrupt-非终止-put-down
title: 实现 Akuma interrupt 非终止 put-down
state: done
priority: 0
needs:
  - task/实现-akuma-status-wait-与唯一-history-投
parent: null
supersedes: []
relates: []
note: ""
createdAt: 2026-08-08T17:32:45.707Z
updatedAt: 2026-08-08T19:46:52.082Z
contractId: null
---
依据 docs/akuma.md owner law 与 Faye act_56，在同一 coherent change 中成文并实现 public interrupt(body)：heart 新增独立 pause control row 及 death-fenced requestPause，禁止复用 kill stop；body polling 观察 pause 后调用 Drive.abort()、记录既有 end=put-down 并释放 leash；grace 后由 akuma.ts 使用 runtime collar probe/putDownProcessTree 兜底；leash 下清 pause，再由 recordTell 事务裁决 concurrent death，最后 spawn wake。返回 typed partial result，覆盖 self-aborted/collar/was-idle/refused-dead/unavailable、孤儿 pause、并发 kill、Claude abort 与物理 process-tree 测试；不得新增 paused life 或 resume。