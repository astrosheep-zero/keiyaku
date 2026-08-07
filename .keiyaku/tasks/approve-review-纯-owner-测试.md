---
id: task/approve-review-纯-owner-测试
title: approve review 纯 owner + 测试
state: done
priority: 1
needs: []
parent: null
supersedes: []
relates: []
note: ""
createdAt: 2026-08-04T09:02:33.883Z
updatedAt: 2026-08-07T11:29:07.421Z
contractId: null
---
review.ts 目前只有 decideReviewChangesRequested（review.ts:35），schema 已支持 approved/reviewedHead（types.ts:170）。补 approve 的纯 decide owner 与测试，按 Delivery Law 8：approve 设 current approval pointer {reviewedHead}；changes-requested/amend/renew/新 petition/终态结算按律清除。小件，可与其他切片并行。

Accepted implementation commit cbcef2e. Added pure decideReviewApproved with current petition/delivery head gate, no RefOperation/reconcile, preserved changes-requested owner. Added deterministic, refusal, real-protocol, and race tests. Independent review-akuma/v4-approve-reconcile-review returned no findings. Coordinator verification: 10 review-focused tests, full suite 111/111, typecheck, build, and diff check pass.