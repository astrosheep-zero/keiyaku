---
id: task/post-audit/make-ci-and-typecheck-gates
title: Make CI and typecheck gates truthful
state: done
priority: 1
needs: []
parent: null
supersedes: []
relates: []
note: ""
createdAt: 2026-09-01T08:38:53.943Z
updatedAt: 2026-09-01T12:51:39.804Z
---
Fix platform-dependent spawn-error fixtures, include tests and scripts in dedicated noEmit typechecks, lint them consistently, and verify the minimum supported Node version rather than only Node 24. Keep npm-only installation.