---
id: task/unify-protocol-attempt-retry-orchestration
title: Unify protocol attempt retry orchestration
state: open
priority: 1
needs: []
parent: task/审计项目架构边界-重复与-owner-错位
supersedes: []
relates: []
note: ""
createdAt: 2026-08-18T03:33:12.842Z
updatedAt: 2026-08-18T03:33:12.842Z
---
为 runProtocol、target-fenced placement、amend、deliver 和 review 收敛一份 attempt lifecycle orchestration，统一处理 continuation、最后一次 collision、publication-failed 和 exhausted。各 operation 只保留自己的 observe/prepare/decide/value projection。

admitDecidedOffer 继续是唯一 admission judge；不得新增预检查、第二 collision 判定器或通用 workflow framework。Focused tests 只固定各 outcome 的终止/继续核心不变量。