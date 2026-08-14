---
id: task/review前置与脏树deliver物化重写
title: review前置与脏树deliver物化重写
state: open
priority: 0
needs:
  - task/迁移-library-方言与-verification-aca216f8
  - task/拆除复合-admission-receipt-与-plac-5a098c75
parent: null
supersedes: []
relates: []
note: "2026-08-12 confirmed regression: review --satisfied on the current patch reached target placement with conflicts in src/akuma/akuma.ts and tests/facade-fleet.test.ts; the command returned integration-failed and admitted no review attestation, leaving reviewed missing. Required invariant already settled by lifecycle/Git law: review admission remains durable and visible; placement reports conflict separately; Contract stays pending-delivery; later patch/document movement alone determines stale testimony. GitHub and Gerrit likewise persist review/votes independently from merge/submit conflict."
createdAt: 2026-08-06T13:30:35.043Z
updatedAt: 2026-08-12T12:35:36.583Z
---
按 Square #184 重写 review/deliver 数据流：review 可在 deliver 前对当前脏树记录 patchId + document key 证词；attestation admission 不预判 currentness，placement 是唯一 currentness 裁判；deliver 将当前 worktree 内容物化为 candidate 后再落 deliver。保持 journal 唯一事实、public Outcome 三支不变，顺手 verification/placement 结果服从 #182 各自动词 Value。不得恢复旧 Delivery.review 前置 delivery 句柄、不得把 evidence blob/log 写入 journal、不得新增第二 authority 或新生命周期动词。实现前更新 docs/model.md、lifecycle.md、transport.md、public-api.md、cli.md 的 owning rules；P0-3 abandon 终态另行处理。
