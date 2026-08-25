---
id: task/maintainability-owner-refactor/return-cli-parsing-and
title: Return CLI parsing and invocation to existing command owners
state: done
priority: 0
needs: []
parent: task/maintainability-owner-refactor/return-all-oversized-source
supersedes: []
relates: []
note: ""
createdAt: 2026-08-24T01:49:58.212Z
updatedAt: 2026-08-24T02:26:09.681Z
---
Move help composition out of parse.ts and command-family adaptation out of invoke.ts into existing command owners. Keep one global argv scanner and one cwd, Repo, World, Settings, and stdin orchestration edge.