---
id: task/压缩-git-测试-fixture-的初始化进程
title: 压缩 Git 测试 fixture 的初始化进程
state: done
priority: 1
needs: []
parent: null
supersedes: []
relates: []
note: ""
createdAt: 2026-08-25T17:16:39.345Z
updatedAt: 2026-08-25T17:42:08.137Z
---
Reduce Git child-process fanout in tests without sharing mutable repositories. makeGitRepository must retain fresh mkdtemp isolation, main branch, test identity, and unset-config behavior. Remove only redundant caller setup; preserve explicit foreign identities and topology tests. Benchmark Git-heavy suites before and after.