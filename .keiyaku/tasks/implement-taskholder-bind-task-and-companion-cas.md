---
id: task/implement-taskholder-bind-task-and-companion-cas
title: Implement TaskHolder bind-task and companion CAS
state: open
priority: 0
needs:
  - task/split-package-root-facade-into-bounded-library-o
parent: null
supersedes: []
relates: []
note: ""
createdAt: 2026-08-11T02:06:56.100Z
updatedAt: 2026-08-11T02:06:56.100Z
contractId: null
---
Implement settlement/holder.ts as the sole holder owner. Add BindInput.task and CLI bind --task. Publish holder changes with bind/abandon facts in one Offer companions CAS. Remove Task Markdown contractId and task --contract interfaces in one hard cut; update docs/settlement.md, docs/task.md, docs/public-api.md, docs/cli.md and direct fixtures.