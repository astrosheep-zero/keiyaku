---
id: task/split-protocol-operations-by-change-reason
title: Split protocol operations by change reason
state: drop
priority: 1
needs:
  - task/replace-source-topology-architecture-allowlists
  - task/require-delivery-document-derivation-at-the-prot
  - task/unify-protocol-attempt-retry-orchestration
parent: task/审计项目架构边界-重复与-owner-错位
supersedes: []
relates: []
note: "Rejected: history found no product change forced to repeat the same judgment because these files are colocated. Cross-surface changes followed shared persistence or frozen-observation invariants; moving coherent owner code into more files would add topology without reducing adjudication points."
createdAt: 2026-08-18T03:33:12.842Z
updatedAt: 2026-08-18T04:27:05.097Z
---
在 retry orchestration 收敛后，将 protocol/operations.ts 按真实变化原因拆为 coherent owner modules：amend、delivery/review、audit、reconcile/read。保持现有 public surface 和 durable semantics；不要保留仅用于转发全部 exports 的第二 public surface，除非当前消费者确实需要。

拆分应让修改一个 operation 不再要求穿过无关 operation，并消除 auditOperation 当前 complexity 超限。测试跟随 owner behavior，不镜像新文件拓扑。