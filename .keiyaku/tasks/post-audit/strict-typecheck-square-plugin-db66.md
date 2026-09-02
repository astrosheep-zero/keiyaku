---
id: task/post-audit/strict-typecheck-square-plugin-db66
title: Strict-typecheck Square plugin test boundary
state: done
priority: 2
needs: []
parent: task/migrate-remaining-historical
supersedes: []
relates: []
note: ""
createdAt: 2026-09-01T13:35:38.673Z
updatedAt: 2026-09-01T14:24:18.436Z
---
Make the Square plugin test boundary pass strict noEmit without changing plugin runtime behavior. Resolve the single TS7016 module declaration gap for plugins/square/index.js using the existing public plugin contract owner. Keep the plugin package shape and tests behavior unchanged; prefer the smallest declaration/typing boundary. Verify tests/plugin-square.test.ts and tests/plugin-types.test.ts plus strict typecheck. Do not widen to other historical test groups.