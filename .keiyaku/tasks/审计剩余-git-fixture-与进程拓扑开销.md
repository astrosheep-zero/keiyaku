---
id: task/审计剩余-git-fixture-与进程拓扑开销
title: 审计剩余 Git fixture 与进程拓扑开销
state: done
priority: 1
needs: []
parent: task/继续压缩-npm-test-的剩余关键路径
supersedes: []
relates: []
note: Static audit found 53 repositoryAt calls in protocol-bind-observe.test.ts and 25 in worktree-places.test.ts. Existing tests/support cachedRepositoryAt is test-only and keys cwd plus gitPath. External worker audit stranded by provider 503; local evidence used.
createdAt: 2026-08-26T03:03:30.381Z
updatedAt: 2026-08-26T03:17:48.097Z
---
Find repeated Git setup, repository discovery, CLI spawning, or cleanup work that can be removed without sharing mutable test state.