---
id: task/maintenance/slim-akuma-execution-request-and-9e27
title: Slim Akuma execution, request, and provider fixtures
state: done
priority: 2
needs: []
parent: task/maintenance/repository-wide-simplification-adad
supersedes: []
relates: []
note: ""
createdAt: 2026-09-29T13:38:26.583Z
updatedAt: 2026-09-29T15:27:46.615Z
---
Reduce repeated body birth, provider fake, owned-process, request argument, pump teardown, and spawn-capable fixture setup across Akuma execution and request tests. Preserve every request, interrupt, kill, fork, provider, cleanup, and recovery assertion. Helpers must encode fixture mechanics, not mirror production lifecycle.