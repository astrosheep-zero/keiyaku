---
id: task/dogfood-e2e-真实-shell-全回路
title: dogfood E2E：真实 shell 全回路
state: drop
priority: 1
needs:
  - task/最小-cli-壳-verb-命令-status-读面
  - task/成文-lifecycle-phase-lattice-law-in-c-9d891508
parent: null
supersedes: []
relates: []
note: ""
createdAt: 2026-08-05T08:47:15.123Z
updatedAt: 2026-08-07T11:29:07.424Z
---
真实 shell E2E 两条路径：happy（bind → open → seal → petition → review --approve → claim）与 forfeit 分支。断言：carrier journal 逐 fact、claim target 单次 CAS、delivery ref/worktree 建立与清场、status 可作恢复读面。回路顺序以 lattice 立法定稿为准（law-in-code 现状是 bind → open → seal，fold.ts:97/101）。通过即宣布 MVP dogfood-ready。