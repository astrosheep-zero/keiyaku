---
id: task/用-cow-git-模板消除测试仓库重复初始
title: 用 CoW Git 模板消除测试仓库重复初始化
state: drop
priority: 1
needs: []
parent: null
supersedes: []
relates: []
note: 验证后放弃：CoW/template 仅减少约 2.4% Git 进程，完整 npm test 墙钟仍约 46s；跨 worker 模板需要额外启动机制，收益不足以支付复杂度。保留独立测试 Git 配置和 --initial-branch 初始化优化。
createdAt: 2026-08-13T00:46:46.593Z
updatedAt: 2026-08-13T01:02:43.729Z
---
