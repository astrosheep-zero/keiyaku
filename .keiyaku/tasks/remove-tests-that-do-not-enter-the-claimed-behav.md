---
id: task/remove-tests-that-do-not-enter-the-claimed-behav
title: Remove tests that do not enter the claimed behavior
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
删除 tests/maintainability.test.js 中只读取 eslint.config.js 并复述 120 字符常量的测试。删除 tests/cli-invoke.test.ts 中 show --json 与 history --json 两段只再次调用 invoke 的重复断言，因为它们没有进入 main 或 renderer，不能证明 JSON 输出。

先核对 main/renderer 是否已有一个真正的 JSON projection invariant；已有则只删除，缺失且确属核心 public invariant时只在真实边界补一次。不得按覆盖率或测试数量补回填充测试。