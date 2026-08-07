---
id: 按真实需求再拆-carrier-git-plumbing
title: 按真实需求再拆 carrier Git plumbing
state: on_hold
pri: 3
needs: []
parent: null
from: []
createdAt: 2026-08-07T00:42:47.633Z
updatedAt: 2026-08-07T00:42:58.893Z
creator: thekoc
---
暂缓。只有未来确实修改 Git 执行或错误分类时，才考虑把 GitPlumbingError、commandError、runGit、runGitWithEnvironment 从 carrier/repository.ts 提到 carrier/git.ts。不得引入吞掉所有 Git 错误的 optional()，不得仅因 v4b 存在而重排其余 carrier/protocol/core/library。
