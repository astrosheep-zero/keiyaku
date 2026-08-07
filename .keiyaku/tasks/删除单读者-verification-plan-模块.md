---
id: task/删除单读者-verification-plan-模块
title: 删除单读者 verification plan 模块
state: done
priority: 1
needs: []
parent: null
supersedes: []
relates: []
note: ""
createdAt: 2026-08-07T04:48:19.222Z
updatedAt: 2026-08-07T11:29:07.447Z
contractId: null
---
src/verification/plan.ts 只被 producer 生产调用，VerificationPlanStep 只是 argv 单字段包装；另一个 reader 是针对该包装的测试。把 executor→argv 映射收回 producer 本地，删除 plan.ts、对应 architecture allow 与包装测试，保留 producer 端精确行为测试。