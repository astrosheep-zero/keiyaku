---
id: task/收束-akuma-heart-存储机械与领域法律
title: 收束 Akuma Heart 存储机械与领域法律可读性
state: done
priority: 0
needs: []
parent: null
supersedes: []
relates: []
note: ""
createdAt: 2026-08-08T18:26:58.518Z
updatedAt: 2026-08-08T18:39:56.144Z
contractId: null
---
依据 docs/akuma.md 的 Heart custody law 与用户对当前 dirty candidate 的架构异议，核查 heart.ts 同时承载 typed facts、life derivation、两套 schema、SQLite codec、事务原语和投影后是否已被存储语法淹没。先由 Faye 根因裁定 custody ownership、source-module factoring 与禁止 repository/second authority 之间的边界；裁决必须先写入 docs/akuma.md，再实施最小结构调整，并以 architecture、focused Heart tests、typecheck、maintainability 和 full test 证明 SQL rows 未泄漏、原子裁决未迁出 Heart。
