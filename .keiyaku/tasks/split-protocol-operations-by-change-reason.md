---
id: task/split-protocol-operations-by-change-reason
title: Split protocol operations by change reason
state: open
priority: 1
needs:
  - task/unify-protocol-attempt-retry-orchestration
parent: task/审计项目架构边界-重复与-owner-错位
supersedes: []
relates: []
note: ""
createdAt: 2026-08-18T03:33:12.842Z
updatedAt: 2026-08-18T03:33:21.432Z
---
在 retry orchestration 收敛后，将 protocol/operations.ts 按真实变化原因拆为 coherent owner modules：amend、delivery/review、audit、reconcile/read。保持现有 public surface 和 durable semantics；不要保留仅用于转发全部 exports 的第二 public surface，除非当前消费者确实需要。

拆分应让修改一个 operation 不再要求穿过无关 operation，并消除 auditOperation 当前 complexity 超限。测试跟随 owner behavior，不镜像新文件拓扑。