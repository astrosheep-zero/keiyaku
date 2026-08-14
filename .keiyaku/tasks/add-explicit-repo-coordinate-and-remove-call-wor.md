---
id: task/add-explicit-repo-coordinate-and-remove-call-wor
title: Add explicit repo coordinate and remove call workdir
state: done
priority: 1
needs: []
parent: null
supersedes: []
relates: []
note: ""
createdAt: 2026-08-11T23:35:03.741Z
updatedAt: 2026-08-13T17:01:12.017Z
---
Make -C the sole invocation and Akuma execution cwd, add a global explicit --repo override with cwd inference fallback, delete call --workdir from CLI grammar and adapters, update owner law, tests, bundled skills, and help.