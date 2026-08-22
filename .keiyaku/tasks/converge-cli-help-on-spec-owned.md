---
id: task/converge-cli-help-on-spec-owned
title: Converge CLI help on spec-owned leaf details
state: done
priority: 1
needs: []
parent: null
supersedes: []
relates: []
note: ""
createdAt: 2026-08-21T07:22:21.846Z
updatedAt: 2026-08-22T07:19:08.351Z
---
Faye act/234 settled the terminal agent-first help model: root/namespace render spec-owned usage plus purpose; leaf adds one opaque spec-owned details string; syntax refusal reuses the same usage. Contract renames help to details, Task query moves its renderer special case into details, Akuma remains unchanged, and no cross-family help framework is introduced.