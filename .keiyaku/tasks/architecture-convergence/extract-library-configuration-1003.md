---
id: task/architecture-convergence/extract-library-configuration-1003
title: Extract library configuration ownership
state: done
priority: 1
needs: []
parent: null
supersedes: []
relates: []
note: ""
createdAt: 2026-09-03T01:20:48.388Z
updatedAt: 2026-09-03T01:46:13.609Z
---
Separate Settings-derived gate and branch policy parsing from Git worktree-hook normalization. Preserve package-root exports while making Settings and Git the sole semantic owners of their own inputs.