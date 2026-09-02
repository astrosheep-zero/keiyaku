---
id: task/share-one-task-board-scan-per-4cfa
title: Share one Task board scan per invocation
state: done
priority: 1
needs: []
parent: null
supersedes: []
relates:
  - task/preserve-accepted-mutation-lags-dea5
note: "Faye act/1035/1037: repeated full Task board scans are a real P1 tax for batch callers. Invariant: one invocation, each World at most one board scan; pass the observed board to downstream Task projections/operations without adding a second authority or persistent child index. Measure one scan only as a decision instrument; no benchmark suite."
createdAt: 2026-09-02T06:23:31.882Z
updatedAt: 2026-09-02T07:08:51.045Z
---
