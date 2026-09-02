---
id: task/post-audit/remove-akuma-validation
title: Remove Akuma validation duplication and gate bypasses
state: done
priority: 3
needs: []
parent: null
supersedes: []
relates: []
note: ""
createdAt: 2026-09-01T08:38:53.943Z
updatedAt: 2026-09-01T11:59:50.524Z
---
Consolidate Akuma public input validation and cwd selection behind one owner boundary, then replace historical-name tombstones and ESLint-disable-based maintainability checks with semantic or centrally bounded exceptions. Keep this as cleanup after runtime risks.