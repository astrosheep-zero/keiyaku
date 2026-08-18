---
id: task/share-contract-and-arc-document-envelope-parsing
title: Share Contract and Arc document envelope parsing
state: open
priority: 1
needs:
  - task/replace-source-topology-architecture-allowlists
parent: task/审计项目架构边界-重复与-owner-错位
supersedes: []
relates: []
note: ""
createdAt: 2026-08-18T03:55:57.451Z
updatedAt: 2026-08-18T03:56:24.400Z
---
抽取 Contract与 Arc decoder共享的顶层 Markdown envelope解析：frontmatter约束、唯一 H1、H1/H2 间空白、stray bytes、H2 title索引/去重。Contract与 Arc各自继续声明允许/必需 sections并解释自己的 body。

不合并两种 document语法，不改变 preserved raw bytes或 amendment render策略。Focused tests各保留一个 envelope invariant和各产品专属 section行为。