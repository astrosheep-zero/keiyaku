---
id: task/post-audit/fix-settings-own-property
title: Fix Settings own-property namespace lookup
state: done
priority: 1
needs: []
parent: null
supersedes: []
relates: []
note: ""
createdAt: 2026-09-01T08:38:53.943Z
updatedAt: 2026-09-01T09:03:13.756Z
---
Make namespace entry lookup ignore inherited properties such as toString and __proto__, preserving opaque namespace behavior and scoped failure semantics. Add focused regression tests.