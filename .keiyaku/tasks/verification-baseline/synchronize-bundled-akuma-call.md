---
id: task/verification-baseline/synchronize-bundled-akuma-call
title: Synchronize bundled Akuma call usages
state: done
priority: 0
needs: []
parent: task/architecture-ownership/reduce-request-execution-and
supersedes: []
relates: []
note: ""
createdAt: 2026-08-28T04:38:34.730Z
updatedAt: 2026-08-28T04:52:46.912Z
---
Restore the CLI-install baseline by synchronizing both derived bundled Akuma call usages with renderAkumaUsage: the root facade retains --contract and the standalone skill removes only that arm. Change only the two stale usage lines; do not change CLI grammar or surrounding prose.