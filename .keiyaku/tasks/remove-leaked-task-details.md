---
id: task/remove-leaked-task-details
title: Remove leaked Task details export
state: done
priority: 0
needs: []
parent: task/restore-full-test-green-after-architecture-polic
supersedes: []
relates: []
note: ""
createdAt: 2026-08-21T09:26:46.664Z
updatedAt: 2026-08-21T09:49:02.881Z
---
Remove observeTaskDetails from the public ./task export surface, retain it in the internal Task owner used by CLI, and restore package-root export assertions. No compatibility alias.