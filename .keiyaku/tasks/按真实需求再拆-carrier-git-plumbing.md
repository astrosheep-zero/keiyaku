---
id: task/按真实需求再拆-carrier-git-plumbing
title: 按真实需求再拆 carrier Git plumbing
state: drop
priority: 3
needs: []
parent: null
supersedes: []
relates: []
note: "Dropped after current-premise audit: src/carrier no longer exists. GitPlumbingError, runGit, and runGitWithEnvironment already have the coherent Git-owned home src/git/process.ts; Git object operations remain in src/git/repository.ts; shared child-process lifetime belongs to src/runtime/proc. Current termination/rejection work follows those owners, so recreating carrier/git.ts would add a duplicate topology without a reader."
createdAt: 2026-08-07T00:42:58.993Z
updatedAt: 2026-08-30T07:18:32.247Z
---
暂缓。只有未来确实修改 Git 执行或错误分类时，才考虑把 GitPlumbingError、commandError、runGit、runGitWithEnvironment 从 carrier/repository.ts 提到 carrier/git.ts。不得引入吞掉所有 Git 错误的 optional()，不得仅因 v4b 存在而重排其余 carrier/protocol/core/library。