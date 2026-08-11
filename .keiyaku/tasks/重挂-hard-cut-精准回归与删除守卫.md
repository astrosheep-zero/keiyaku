---
id: task/重挂-hard-cut-精准回归与删除守卫
title: 重挂 hard-cut 精准回归与删除守卫
state: done
priority: 0
needs:
  - task/迁移-library-方言与-verification-aca216f8
parent: null
supersedes: []
relates: []
note: ""
createdAt: 2026-08-07T05:57:30.475Z
updatedAt: 2026-08-07T11:29:07.462Z
---
重挂 bind/amend/deliver/review/audit/dogfood 的最小精准测试；证明 human review 依赖整体 document key、machine attestation 只依赖指令段 key、同 gate 同 subject 后置 unsatisfied 覆盖、verified 无指令被外围拒绝。加入 core 禁词和 persisted current-version hard-cut 守卫，不保留兼容 decoder。