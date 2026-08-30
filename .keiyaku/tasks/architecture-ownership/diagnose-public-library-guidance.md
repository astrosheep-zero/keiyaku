---
id: task/architecture-ownership/diagnose-public-library-guidance
title: Diagnose public Library guidance expectation
state: done
priority: 1
needs: []
parent: task/architecture-ownership/reduce-request-execution-and
supersedes: []
relates: []
note: ""
createdAt: 2026-08-28T16:55:13.822Z
updatedAt: 2026-08-28T16:56:49.838Z
---
Reproduce the unchanged tests/public-library.test.ts multiline guidance regex failure near line 470 on current main. Determine whether current canonical guidance output or the test expectation owns the correction, identify the landed change, and return the minimal repair surface without mixing it into Routing.