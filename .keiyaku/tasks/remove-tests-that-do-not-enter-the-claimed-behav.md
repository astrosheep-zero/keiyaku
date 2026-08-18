---
id: task/remove-tests-that-do-not-enter-the-claimed-behav
title: Remove tests that do not enter the claimed behavior
state: in_progress
priority: 1
needs: []
parent: task/审计项目架构边界-重复与-owner-错位
supersedes: []
relates: []
note: ""
createdAt: 2026-08-18T03:33:12.842Z
updatedAt: 2026-08-18T03:57:36.824Z
---
删除 tests/cli-invoke.test.ts 中 show --json 与 history --json 两段只再次调用 invoke 的断言；invoke不消费 --json，因而这些断言没有进入 main或 renderer，不能证明 JSON output。max-len配置复述已随 maintainability gate任务删除，不重复处理；Workspace Place重复状态测试由对应 Workspace任务拥有。

先核对 main/renderer是否已有一次真正的 JSON projection invariant；已有则只删除，缺失且确属 public core invariant时在真实边界补一次。不得按覆盖率或测试数量补回填充测试，不合并不同 recovery/corruption/lifecycle状态。
