---
id: task/批量读取-carrier-journals-消除进程放大
title: 批量读取 carrier journals 消除进程放大
state: done
priority: 1
needs: []
parent: null
supersedes: []
relates: []
note: ""
createdAt: 2026-08-06T08:15:23.502Z
updatedAt: 2026-08-07T11:29:07.454Z
contractId: null
---
observeCarrier 先读 carrier tree，再为每份 contract journal 单独执行一次 git cat-file。status、world reconcile 与 eligibility-changing protocol 因此产生 O(N) 个 Git 子进程；重试会重复该放大。当前没有 N²，但 process topology 会随契约数线性恶化。

在 carrier repository 边界增加一个成熟 Git batch plumbing 读取原语，一次不可变 carrier snapshot 内批量取得 format 与 journal blobs；observeContracts 的小集合路径也复用同一能力。保持每份 journal 的 canonical decode/fold 与错误定位。新增规模测试按 Git invocation 次数断言全仓观察为常数级进程数，而不是用大而慢的计时测试填充。