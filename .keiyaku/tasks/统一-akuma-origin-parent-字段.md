---
id: task/统一-akuma-origin-parent-字段
title: 统一 Akuma origin parent 字段
state: open
priority: 2
needs: []
parent: null
supersedes: []
relates: []
note: ""
createdAt: 2026-08-09T01:10:10.541Z
updatedAt: 2026-08-09T01:10:10.541Z
contractId: null
---
以 docs/akuma.md 为权威，将 request origin 的 parentId 与 fork origin 的 parent 收束为同一字段名；更新 codec、tests 和当前 hard-cut schema，不做兼容分支。来源：Faye Cut 3 milestone review act_81 nonblocker 1。