---
id: task/清除-carrier-placement-双裁判与-t-eb75d4e7
title: 清除 carrier placement 双裁判与 target CAS 预判
state: done
priority: 0
needs: []
parent: null
supersedes: []
relates: []
note: ""
createdAt: 2026-08-07T04:47:49.837Z
updatedAt: 2026-08-07T11:29:07.459Z
contractId: null
---
按 docs/lifecycle.md 的 pact/protocol/admission 单裁判边界收缩 carrier admission：

- 删除 target `update-ref` 之前的 `readRef` 预判；只有原子事务裁定 target 是否移动，失败后再观察并返回 typed ref-moved。
- 删除 carrier 对 claimed/delivery/coordinates 的二次 fold 与 target pairing 语义审查；这些由 decidePlacement 生成 Offer，carrier 只保留物理 ref 约束和 CAS。
- 删除因此失效的 rebuildAfterCarrierMovement 分支和 offer journal 语义 fold；保留持久化 journal canonical decode、contract-head movement 判定和 protocol accepted snapshot fold。
- 加一个 target 短暂漂移又恢复时不被旧预读拒绝的精准边界测试，或在现有 atomic-ref 测试中证明只有事务输出决定。