---
id: approve-review-纯-owner-测试
title: approve review 纯 owner + 测试
state: in_progress
pri: 1
needs: []
parent: null
from: []
createdAt: 2026-08-04T06:15:04.541Z
updatedAt: 2026-08-04T08:37:21.216Z
creator: thekoc
startedAt: 2026-08-04T08:37:21.216Z
---
review.ts 目前只有 decideReviewChangesRequested（review.ts:35），schema 已支持 approved/reviewedHead（types.ts:170）。补 approve 的纯 decide owner 与测试，按 Delivery Law 8：approve 设 current approval pointer {reviewedHead}；changes-requested/amend/renew/新 petition/终态结算按律清除。小件，可与其他切片并行。
