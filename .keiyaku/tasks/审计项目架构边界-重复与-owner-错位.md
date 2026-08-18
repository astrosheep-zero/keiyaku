---
id: task/审计项目架构边界-重复与-owner-错位
title: 审计项目架构边界、重复与 owner 错位
state: open
priority: 1
needs: []
parent: null
supersedes: []
relates: []
note: ""
createdAt: 2026-08-17T03:25:45.037Z
updatedAt: 2026-08-18T03:33:12.842Z
---
本任务是基于当前代码的事实账本与交付拆分，不是架构权威。实现前必须回到对应 docs owner 章节；只有新沉淀的 durable law 才更新该唯一 owner。

事实来源按责任域拆给四只 Akuma：Contract/Protocol、Akuma runtime、World/Task/Kanshi/CLI、当前测试。Akuma 只提炼代码结构、调用链和覆盖事实；以下成立性、严重度、删除项与依赖由主 agent 对照 owner law 裁决。

## 当前裁决

1. 保留 120-column max-len、复杂度和函数体 gate。文件总行数不能作为 hard error；当前 400 行 warning 再由脚本把 500 行提升为 error，会激励压缩自然多行代码。不存在通用的 240 行合理线。
2. admitDecidedOffer 仍是唯一 Git admission judge，没有发现第二 admission authority。但 run、fenced placement、amend、deliver、review 重复编排 publication-failed、collision、redecide 和 exhausted，属于同一重试政策的多份实现。
3. protocol/operations.ts 同时承担 reads、amend、deliver/review、audit、reconcile。统一 attempt orchestration 后，应按变化原因拆开；不能仅因同属 Protocol owner 就永久豁免一个多变化原因模块。
4. Task 普通 mutation 与 compose 各自实现同一 updatedAt 单调推进规则。应共享纯 advancement 规则，同时保留两类调用方不同的 clock capture ownership。projectReady 没有生产或测试读者，应删除。
5. Akuma runtime 暂未确认第二事实 authority。单个不可读 fleet member 的静默 skip 是正确语义，保持不变。真正的问题是 fleet public law 同时写在 akuma-public、akuma、akuma-heart；应只由 akuma-public 拥有，其他章节保留各自内部法并引用 owner。
6. 当前确认三条填充测试没有进入它们声称的行为：maintainability 测试复述 eslint max-len 常量；cli invoke 中 show --json 和 history --json 都没有进入 main 或 renderer，只重复 invoke 分支。Git recovery、Akuma birth window/corrupt member 覆盖不同状态，不删除。
7. 旧 F1-F8 已逐项被当前实现、当前 owner law 或 focused tests 推翻，不能继续作为实施清单；本次用以上当前裁决完整替换。

## 边界

不按文件行数直接拆架构，不删除 max-len，不用压行满足 max-lines，不改变 Akuma 静默 skip，不把同一 durable fact 复制到多个 owner 文档，不做全仓顺手重排。每个 child 只处理一个变化原因，并以最小核心不变量验证。
