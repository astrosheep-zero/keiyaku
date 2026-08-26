---
id: task/评估-git-读操作批处理边界
title: 评估 Git 读操作批处理边界
state: done
priority: 2
needs: []
parent: task/根治优化-npm-test-的-git-heavy-测试架构
supersedes: []
relates: []
note: ""
createdAt: 2026-08-25T16:06:24.938Z
updatedAt: 2026-08-25T16:55:37.119Z
---
Measure runGit and existing GitReadObservation/cat-file batch behavior. Propose or implement only a bounded read-only batching slice if exact ownership and error semantics stay unchanged. Keep writes and worktree operations as independent commands.