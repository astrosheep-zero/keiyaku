---
id: task/add-dispatch-and-alias-owners-and-facade-summon
title: Add dispatch and alias owners and facade summon
state: open
priority: 0
needs:
  - task/implement-taskholder-bind-task-and-companion-cas
  - task/hard-cut-akuma-archetype-vocabulary-and-catalog
parent: null
supersedes: []
relates: []
note: ""
createdAt: 2026-08-11T02:06:56.471Z
updatedAt: 2026-08-11T02:06:56.471Z
contractId: null
---
Implement concrete dispatch Git facts and world-local alias resource, then move call/fork orchestration into library/summon.ts. Call may omit Contract; only Contract-bearing calls write dispatch; fork propagates dispatch, never alias. Use existing Git and coordination primitives. Update owner docs and public types.