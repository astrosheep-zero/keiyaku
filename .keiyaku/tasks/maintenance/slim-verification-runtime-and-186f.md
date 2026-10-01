---
id: task/maintenance/slim-verification-runtime-and-186f
title: Slim verification, runtime, and plugin fixtures
state: done
priority: 2
needs: []
parent: task/maintenance/repository-wide-simplification-adad
supersedes: []
relates: []
note: ""
createdAt: 2026-09-29T13:38:26.583Z
updatedAt: 2026-09-29T14:18:13.793Z
---
Reduce repeated runtime process setup and teardown, environment restoration, verification fixtures, and plugin bootstrap/source fixtures. Preserve descendant-process, timeout, verification, plugin isolation, and Square environment assertions. Do not absorb or relabel the unresolved runtime-process census failure.