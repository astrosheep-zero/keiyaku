---
id: task/以-source-documentkey-封闭并发-ame-78e57c71
title: 以 source DocumentKey 封闭并发 amend 丢更新
state: done
priority: 0
needs:
  - task/收束-core-decision-observation-为唯-5ab4af33
parent: null
supersedes: []
relates: []
note: ""
createdAt: 2026-08-06T21:58:55.941Z
updatedAt: 2026-08-07T11:29:07.442Z
contractId: null
---
按 docs/document.md、docs/lifecycle.md、docs/public-api.md，library 对旧文档应用 H2 增量后，必须把 source DocumentKey 与 complete replacement 一起交给 decideAmend。唯一 decide 在 missing/terminal 之后比较 attempt observation 的 current document key；不匹配返回 document-moved，禁止把 D0 派生的 replacement 静默写到 D1。无自动重读/重放 operation、无 merge engine、无第二 CAS。添加两个并发 amend 的精准 lost-update 回归。